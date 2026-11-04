// Workspace (area B): the chrome around the photo. Styles: styles/workspace.css (+ the height controls in manage.css).
//   top bar      the scene switcher (opens the Scenes page) and the rendering chip; desktop: the tools at the right
//   tools        Adjust floor, Occlusion, Fit (zoom), Render — desktop in the top bar, phone in a row above the dock.
//                Built once per mode, so each test handle (contract §4.6) exists exactly once.
//   bars         selection bar (−15°, +15°, height, Drop to floor, Remove, Done; phone: the lift column too), the
//                Adjust floor card (height, field of view, roll, the ruler, Reset, Looks right)
//   overlay      selection footprint, label and rotate grip; a raised piece's guide line; the horizon line and its handle
//                (drag it to set the pitch); the ruler's points and distance
//   cards        opening / calibrating a scene, no scene open, the one-time gesture hint (phone)
// It also tells the engine which part of the window the photo may use (engine.setStageInsets).
// ctx.workspace: { requestRender(), setAdjust(on) }
// Shell events it sends (cancelable; preventDefault() to take over): 'render-request' {}, 'open-render' { meta }
import { ring, unsavedGlyph, icon } from './icons.js'
import { dimsText, quiet, MAX_ELEVATION, CAMERA_RANGE } from '../engine.js'
import { sceneTitle } from '../data.js'

const NS = 'http://www.w3.org/2000/svg'
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false))
const fromHtml = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild }
const glyph = (body, size = 20, vb = 20, sw = 1.5) => fromHtml(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`)
const G = {
  rotL: '<path d="M5 8.2A6 6 0 1 1 4.5 12"/><path d="M4.2 4.5v4h4"/>',
  rotR: '<path d="M15 8.2A6 6 0 1 0 15.5 12"/><path d="M15.8 4.5v4h-4"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5"/>',
  grip: '<path d="M12.6 6.2A5 5 0 1 0 13 9.5"/><path d="M13.2 3v3.4H9.8"/>',
  floor: '<path d="M2 15.5l4.5-6h7l4.5 6z"/><path d="M6 12.5h8M8.3 9.5l-1.6 6M11.7 9.5l1.6 6"/>',
  occl: '<rect x="2.5" y="8" width="9" height="8" rx="1"/><path d="M8.5 8V5.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-5" stroke-dasharray="2 1.6"/>',
  fit: '<path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5"/><rect x="6.5" y="6.5" width="7" height="7" rx="1"/>',
  ruler: '<rect x="2" y="7" width="16" height="6" rx="1" transform="rotate(-20 10 10)"/><path d="M6.2 8.7l.7 1.9M9.1 7.6l.7 1.9M12 6.6l.7 1.9"/>',
  horizon: '<path d="M2 10h16"/><path d="M10 3.5v4M8 5.5l2-2 2 2M10 16.5v-4M8 14.5l2 2 2-2"/>',
  scenes: '<rect x="2.5" y="4" width="15" height="12" rx="1.5"/><path d="M2.5 13l4-3.5 3 2.5 2.5-2 5.5 4"/>',
}
const HINT_KEY = 'midstudy.hint.gestures'
const HORIZON_FINE = 0.12 // ° of tilt per CSS px, at most, when dragging the horizon
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('-', '−')

export function mount(ctx) {
  const { engine, scenes, shell, kit } = ctx
  const { h, kbd } = kit
  const root = document.documentElement
  const phone = () => shell.isPhone()
  const on = (t, type, fn) => t.addEventListener(type, fn)
  const ask = (name, detail) => !shell.events.dispatchEvent(new CustomEvent(name, { detail, cancelable: true })) // true: someone took it
  let rendering = null    // { t0 } while a render runs
  let lastRemoved = null  // { snap, toast, undo } for Undo / ⌘Z

  // --- top bar ---------------------------------------------------------------------------------------------------
  const switcher = h('button.ws-switcher', { type: 'button', 'aria-label': 'Scenes', dataset: { tip: 'All scenes' }, onclick: () => shell.openPage('scenes') })
  const chips = h('div.ws-chips')
  const left = h('div.ws-top-left', switcher, chips)
  const right = h('div.ws-top-right')
  shell.mounts.topbar.append(left, right)
  const toolRow = h('div.ws-tools', { role: 'toolbar', 'aria-label': 'Tools' })
  shell.mounts.rail.append(toolRow)

  // --- tools: one set, in the top bar (desktop) or the row above the dock (phone) ---------------------------------
  const tools = {}
  function buildTools() {
    const desk = !phone()
    const mk = (id, g, label, tip, onclick, cls = '') => {
      const b = desk
        ? h(`button.ws-tool${cls}`, { type: 'button', onclick, dataset: { midstudy: id, tip } }, glyph(g, 16, 20, 1.75), h('span', label))
        : h(`button.ws-tl${cls}`, { type: 'button', onclick, 'aria-label': tip, dataset: { midstudy: id } }, glyph(g, 22, 20, 1.6), h('span', label))
      tools[id] = b
      return b
    }
    const adjust = mk('adjust-floor', G.floor, 'Adjust floor', 'Line the grid up with the floor', () => setAdjust(!engine.getAdjustFloor()))
    const occl = mk('occlusion', G.occl, 'Occlusion', 'Hide furniture behind things in the photo', () => toggleOcclusion())
    const fit = mk('zoom-fit', G.fit, 'Fit', 'Fit the photo (pinch or scroll to zoom)', () => engine.fitView())
    const render = mk('render', '<path d="M9 3l1.5 4.5L15 9l-4.5 1.5L9 15l-1.5-4.5L3 9l4.5-1.5z"/><path d="M15.5 13v4M13.5 15h4"/>', 'Render', 'Render a photoreal image (paid)', () => requestRender(), '.is-strong')
    fill(right)
    fill(toolRow)
    if (desk) fill(right, adjust, occl, h('span.ws-divider'), fit, h('span.ws-divider'), render)
    else fill(toolRow, adjust, occl, fit, render)
    syncTools()
  }
  function syncTools() {
    const open = !!engine.getSceneName()
    for (const b of Object.values(tools)) b.disabled = !open
    tools['adjust-floor']?.setAttribute('aria-pressed', String(engine.getAdjustFloor()))
    const st = engine.getScene()
    const occl = tools.occlusion
    if (occl) {
      occl.setAttribute('aria-pressed', String(!!st && st.hasDepth && engine.getOcclusion()))
      occl.classList.toggle('is-unavailable', !!st && !st.hasDepth)
      if (!phone()) occl.dataset.tip = st && !st.hasDepth ? 'No depth for this photo: nothing in it hides furniture' : 'Hide furniture behind things in the photo'
    }
    const z = engine.getView().zoom
    const fit = tools['zoom-fit']
    if (fit) {
      fit.lastChild.textContent = z > 1.001 ? `${z.toFixed(1)}×` : 'Fit'
      fit.setAttribute('aria-pressed', String(z > 1.001))
    }
  }
  function toggleOcclusion() {
    const st = engine.getScene()
    if (st && !st.hasDepth) shell.toast('This photo has no depth map, so nothing in it can hide the furniture.', { id: 'no-depth', ms: 4000 })
    engine.setOcclusion(!engine.getOcclusion())
  }

  // --- render: request, chip, ready toast ----------------------------------------------------------------------------
  function requestRender() {
    if (!engine.getSceneName()) return
    if (ask('render-request', {})) return
    quiet(engine.renderViewInternal({}))
  }
  let renderTimer = null
  on(engine.events, 'render', (e) => {
    const { phase, meta } = e.detail
    if (phase === 'start') {
      rendering = { t0: performance.now() }
      clearInterval(renderTimer)
      renderTimer = setInterval(renderChips, 1000)
    } else {
      rendering = null
      clearInterval(renderTimer)
      if (phase === 'done' && meta) shell.toast('Render ready', { kind: 'ok', id: 'render-ready', ms: 10000, action: { label: 'View', onClick: () => { if (!ask('open-render', { meta })) shell.openPanel('renders') } } })
    }
    renderChips()
  })
  function renderChips() {
    if (!rendering) { fill(chips); return }
    const el = (performance.now() - rendering.t0) / 1000
    const leftS = Math.max(0, 25 - el)
    const c = h('span.ws-chip.is-rendering', h('span.ws-chip-glyph', ring(Math.min(0.95, el / 25), { size: phone() ? 16 : 14 })), h('span.ws-chip-text', leftS > 3 ? `Rendering… · about ${Math.ceil(leftS / 5) * 5} s` : 'Rendering…'))
    fill(chips, h('button.ws-chip-hit', { type: 'button', onclick: () => shell.openPanel('renders'), 'aria-label': 'Rendering' }, c))
  }

  // --- the switcher -------------------------------------------------------------------------------------------------
  function switcherInfo() {
    const name = engine.getSceneName()
    const load = engine.getSceneLoad()
    if (load.loading) {
      const s = load.scene || scenes.getScene(load.name)
      return { state: 'loading', title: s ? sceneTitle(s) : 'Scene', glyph: ring(null, { size: 14, tone: 'text' }), word: load.phase === 'calibrating' ? 'Calibrating…' : 'Opening…' }
    }
    if (!name) return { state: 'none', title: 'Scenes', glyph: glyph(G.scenes, 16), word: scenes.getState().loaded && !scenes.getScenes().length ? 'None yet' : '' }
    const title = sceneTitle(engine.getScene() || scenes.getScene(name))
    if (engine.isSceneDirty() || engine.isLayoutDirty()) return { state: 'unsaved', title, glyph: unsavedGlyph(14), word: 'Unsaved' }
    if (engine.getFloorNote() && engine.getCameraSource() !== 'manual') return { state: 'check', title, glyph: icon('warning', { size: 16, stroke: 1.75 }), word: 'Check the floor' }
    return { state: 'ready', title, glyph: h('span.dot'), word: '' }
  }
  function renderSwitcher() {
    const s = switcherInfo()
    switcher.dataset.state = s.state
    const chevron = icon('chevron-down', { size: 16, stroke: 1.9 })
    chevron.classList.add('ws-chevron')
    fill(switcher, h('span.ws-sw-glyph', s.glyph), h('span.ws-sw-title', s.title), s.word ? h('span.ws-sw-word', s.word) : null, phone() && s.word ? null : chevron)
    switcher.setAttribute('aria-label', `${s.title}${s.word ? `, ${s.word}` : ''}. Open scenes`)
  }

  // --- bottom: bars and cards (in #modebar) --------------------------------------------------------------------------
  const selBar = h('div.ws-selbar', { hidden: true })
  const adjustCard = h('div.ws-adjust', { hidden: true, role: 'group', 'aria-label': 'Adjust floor' })
  const loadCard = h('div.ws-loadcard', { hidden: true, role: 'status' })
  const emptyCard = h('div.ws-empty', { hidden: true })
  const hint = h('div.ws-hint', { hidden: true })
  const lift = h('div.ws-lift', { hidden: true, role: 'group', 'aria-label': 'Height above the floor' })
  shell.mounts.modebar.append(selBar, adjustCard, loadCard, emptyCard, hint, lift)

  // --- overlay ----------------------------------------------------------------------------------------------------------
  const svg = document.createElementNS(NS, 'svg')
  svg.classList.add('ws-svg')
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e }
  const fpPoly = mk('polygon', { class: 'ws-fp' })
  const fpStem = mk('line', { class: 'ws-fp-stem' })
  const guide = mk('line', { class: 'ws-guide' })
  const guideDot = mk('ellipse', { class: 'ws-guide-dot', rx: 7, ry: 3 })
  const horizonShadow = mk('line', { class: 'ws-horizon-shadow' })
  const horizonLine = mk('line', { class: 'ws-horizon' })
  const rulerShadow = mk('line', { class: 'ws-mline-shadow' })
  const rulerLine = mk('line', { class: 'ws-mline' })
  svg.append(guide, guideDot, fpPoly, fpStem, horizonShadow, horizonLine, rulerShadow, rulerLine)
  const label = h('div.ws-label', { 'aria-hidden': 'true' })
  const grip = h('button.ws-grip', { type: 'button', 'aria-label': 'Rotate (drag)', dataset: { tip: 'Drag to rotate', kbd: 'R' } }, h('span', glyph(G.grip, 16, 16, 1.7)))
  const horizonHandle = h('div.ws-horizon-handle', { role: 'slider', 'aria-label': 'Horizon: drag up or down to tilt the camera', dataset: { midstudy: 'horizon' } }, h('span', glyph(G.horizon, 18, 20, 1.7)))
  const horizonTag = h('div.ws-horizon-tag', { hidden: true })
  const pill = h('div.ws-dist', { hidden: true })
  const handles = [0, 1].map((i) => h('div.ws-handle', { dataset: { i }, hidden: true }, h('span')))
  shell.mounts.overlays.append(svg, label, grip, horizonHandle, horizonTag, pill, ...handles)

  // --- helpers --------------------------------------------------------------------------------------------------------
  const set = (el, show) => { el.hidden = !show; return show }
  const busy = () => engine.getSceneLoad().loading || !engine.getSceneName()

  // --- selection bar + height (§2.10) ------------------------------------------------------------------------------
  function removeSelected() {
    const uid = engine.getSelected()
    if (!uid) return
    const snap = engine.removeItemWithUndo(uid)
    if (!snap) return
    const undo = () => { if (lastRemoved?.snap === snap) lastRemoved = null; quiet(engine.restoreItem(snap)) }
    const t = shell.toast(`${snap.name} removed`, { id: `removed:${uid}`, icon: 'trash', ms: 6000, action: { label: 'Undo', onClick: undo } })
    if (!phone()) t.el.querySelector('.toast-action')?.append(kbd(isMac ? '⌘Z' : 'Ctrl Z'))
    lastRemoved = { snap, toast: t, undo }
  }
  function explainMissing() {
    const it = engine.getItem(engine.getSelected())
    shell.toast(it?.noGlb ? `${it.name} has no GLB model (only a splat), so it shows as a box at its size.` : `${it?.name || 'This piece'} isn't in the library any more, so it shows as a box at its size. Restore it from Library › Recently removed, or Remove it here.`, { id: 'missing-why', ms: 9000 })
  }
  const selUid = () => engine.getSelected()
  const elevCm = () => { const y = selUid() ? engine.getElevation(selUid()) : 0; return Math.round((y || 0) * 100) }
  const setElevCm = (v) => { const u = selUid(); if (u) engine.setElevation(u, Math.min(MAX_ELEVATION * 100, Math.max(0, Math.round(v))) / 100) }
  const nudge = (cm) => { const u = selUid(); if (u) engine.nudgeElevation(u, cm / 100) }
  const raised = () => { const it = engine.getItem(selUid()); return !!it && it.position[1] > 0.0005 }
  function drop() { const u = selUid(); if (u) engine.dropToFloor(u) }
  // + / − : one cm a press (on pointer down, so a quick tap counts once), held repeats faster
  function holdBtn(cls, dir, labelText, midstudyName, size) {
    let t = null, n = 0
    const stop = () => { clearTimeout(t); t = null }
    let pressed = false
    return h(`button.${cls}`, {
      type: 'button', 'aria-label': labelText, dataset: { midstudy: midstudyName, tip: labelText, kbd: dir > 0 ? 'PgUp' : 'PgDn' },
      onpointerdown: (e) => {
        if (e.button) return
        pressed = true
        n = 0
        nudge(dir)
        const go = () => { n++; nudge(dir * (n > 14 ? 5 : 1)); t = setTimeout(go, n > 8 ? 50 : 100) }
        t = setTimeout(go, 450)
      },
      onpointerup: stop, onpointerleave: stop, onpointercancel: stop, oncontextmenu: (e) => e.preventDefault(),
      // a click without a pointer press (keyboard, or a script's element.click()) nudges once
      onclick: () => { if (!pressed) nudge(dir); pressed = false },
    }, icon(dir > 0 ? 'plus' : 'minus', { size }))
  }
  const elevInputs = new Set()
  function elevInput(cls) {
    const input = h(`input.${cls}.tnum`, { type: 'text', inputmode: 'numeric', enterkeyhint: 'done', autocomplete: 'off', spellcheck: false, 'aria-label': 'Height above the floor, cm', dataset: { midstudy: 'elev-value' } })
    const commit = () => {
      const v = parseFloat(String(input.value).replace(',', '.').replace('−', '-'))
      if (Number.isFinite(v)) setElevCm(v)
      input.value = String(elevCm())
    }
    input.addEventListener('change', commit)
    input.addEventListener('focus', () => input.select())
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur() }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = String(elevCm()); input.blur() }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)) }
    })
    elevInputs.add(input)
    return input
  }
  const dropBtns = new Set()
  function syncElev() {
    const cm = String(elevCm())
    for (const i of elevInputs) if (i.isConnected && document.activeElement !== i && i.value !== cm) i.value = cm
    for (const b of dropBtns) b.disabled = !raised()
  }
  function buildLift() {
    if (!phone()) { lift.replaceChildren(); return }
    const handle = h('div.ws-lift-grip', { role: 'slider', 'aria-label': 'Drag up or down to raise or lower', 'aria-valuemin': '0', 'aria-valuemax': String(MAX_ELEVATION * 100) }, h('i'), h('i'), h('i'))
    let d = null
    handle.addEventListener('pointerdown', (e) => { d = { id: e.pointerId, y0: e.clientY, cm0: elevCm() }; handle.setPointerCapture?.(e.pointerId); handle.classList.add('is-active'); e.preventDefault() })
    handle.addEventListener('pointermove', (e) => { if (d && e.pointerId === d.id) setElevCm(d.cm0 + (d.y0 - e.clientY) / 2) })
    const end = () => { d = null; handle.classList.remove('is-active') }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
    const dropB = h('button.ws-lift-btn.is-tool', { type: 'button', 'aria-label': 'Drop to floor', dataset: { midstudy: 'drop' }, onclick: drop }, icon('drop'))
    dropBtns.add(dropB)
    fill(lift,
      holdBtn('ws-lift-btn', 1, 'Up 1 cm', 'elev-up', 20),
      h('label.ws-lift-value', elevInput('ws-lift-input'), h('span', 'cm')),
      handle,
      holdBtn('ws-lift-btn', -1, 'Down 1 cm', 'elev-down', 20),
      h('span.ws-lift-div'),
      dropB)
  }
  function buildSelBar() {
    elevInputs.clear(); dropBtns.clear()
    const sel = engine.getItem(selUid())
    const missing = !!sel?.missing || !!sel?.noGlb
    if (phone()) {
      const it = (g, text, onclick, cls = '', ds = null) => h(`button.ws-sb-item${cls}`, { type: 'button', onclick, dataset: ds }, g, h('span', text))
      fill(selBar,
        missing ? it(icon('warning'), sel?.noGlb ? 'No GLB' : 'Missing', explainMissing, '.is-narrow.is-missing', { midstudy: 'missing-item' }) : null,
        it(glyph(G.rotL), '−15°', () => engine.rotateSelected(-15)),
        it(glyph(G.rotR), '+15°', () => engine.rotateSelected(15)),
        it(glyph(G.trash), 'Remove', removeSelected, '.is-narrow.is-danger'),
        h('span.ws-spacer'),
        h('button.ws-done', { type: 'button', onclick: () => engine.select(null) }, 'Done'))
      buildLift()
    } else {
      const it = (g, text, key, tip, onclick, cls = '') => h(`button.ws-sb-item${cls}`, { type: 'button', onclick, dataset: { tip, kbd: key } }, g, text ? h('span', text) : null, key ? kbd(key) : null)
      const dropB = it(icon('drop', { size: 16, stroke: 1.75 }), 'Drop to floor', null, 'Back down to the floor', drop)
      dropB.dataset.midstudy = 'drop'
      dropBtns.add(dropB)
      fill(selBar,
        missing ? h('button.ws-missing', { type: 'button', dataset: { midstudy: 'missing-item', tip: sel?.noGlb ? 'No GLB model: shown as a box at its size' : 'Removed from the library: shown as a box at its size' }, onclick: explainMissing }, icon('warning', { size: 16, stroke: 1.75 }), h('span', sel?.noGlb ? 'No GLB' : 'Missing item')) : null,
        missing ? h('span.ws-divider') : null,
        it(glyph(G.rotL, 16, 20, 1.6), '−15°', '⇧R', 'Rotate back 15°', () => engine.rotateSelected(-15)),
        it(glyph(G.rotR, 16, 20, 1.6), '+15°', 'R', 'Rotate 15°', () => engine.rotateSelected(15)),
        h('span.ws-divider'),
        h('div.ws-elev', { role: 'group', 'aria-label': 'Height above the floor', dataset: { tip: 'Height above the floor · Shift+drag, PageUp / PageDown' } },
          h('span.ws-elev-cap', 'Height'),
          holdBtn('ws-elev-btn', -1, 'Down 1 cm', 'elev-down', 16),
          h('label.ws-elev-field', elevInput('ws-elev-input'), h('span', 'cm')),
          holdBtn('ws-elev-btn', 1, 'Up 1 cm', 'elev-up', 16)),
        dropB,
        h('span.ws-divider'),
        it(glyph(G.trash, 16, 20, 1.6), 'Remove', 'Del', 'Remove from the scene', removeSelected, '.is-danger'),
        h('button.ws-done', { type: 'button', onclick: () => engine.select(null), dataset: { tip: 'Deselect' } }, h('span', 'Done'), h('kbd.kbd.is-ink', 'Esc')))
      lift.replaceChildren()
    }
    syncElev()
  }

  // --- Adjust floor (§4.5) -------------------------------------------------------------------------------------------
  // Sliders for the camera height (cm), field of view (°) and roll (°); the horizon line sets the pitch; an optional
  // two-tap ruler; Reset (back to the automatic camera) and Looks right (save; manual if anything changed).
  const camRows = {}
  function camSlider(id, key, text, unit, min, max, step, toUi, fromUi, digits) {
    const out = h('span.ws-adj-value.tnum')
    const input = h('input.slider', { type: 'range', min, max, step, 'aria-label': text, dataset: { midstudy: id } })
    const apply = () => { const v = Number(input.value); if (Number.isFinite(v)) engine.setCamera({ [key]: fromUi(v) }) }
    input.addEventListener('input', apply)
    input.addEventListener('change', apply)
    const row = h('label.ws-adj-row', h('span.ws-adj-head', h('span.ws-adj-label', text), out), input)
    row.sync = () => {
      const v = toUi(engine.getCamera()[key])
      if (document.activeElement !== input || String(input.value) !== String(v)) input.value = String(v)
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`)
      out.textContent = `${Number(v).toFixed(digits).replace('-', '−')} ${unit}`
    }
    camRows[id] = row
    return row
  }
  function buildAdjust() {
    const [hl, hh] = CAMERA_RANGE.height_m, [fl, fh] = CAMERA_RANGE.fov_y_deg, [rl, rh] = CAMERA_RANGE.roll_deg
    const note = h('p.ws-adj-note')
    const pitch = h('span.ws-adj-pitch.tnum')
    const rulerBtn = h('button.ws-adj-btn.is-quiet', { type: 'button', 'aria-pressed': 'false', onclick: () => engine.setRulerActive(!engine.getRuler().active) }, glyph(G.ruler, 18), h('span', 'Ruler'))
    const rulerText = h('span.ws-adj-ruler.tnum')
    // A known length fixes the scale: "Really [ ] cm · Set scale" scales the camera height (engine.setRulerTrueLength).
    const trueInput = h('input.input.ws-adj-true.tnum', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off', spellcheck: false, placeholder: 'e.g. 200', 'aria-label': 'Its real length, cm', dataset: { midstudy: 'ruler-true' } })
    const applyTrue = () => {
      const cm = parseFloat(String(trueInput.value).replace(',', '.'))
      if (!(cm > 0)) { trueInput.focus(); return }
      const exact = engine.setRulerTrueLength(cm / 100)
      trueInput.value = ''
      trueInput.blur()
      const hcm = Math.round(engine.getCamera().height_m * 100)
      shell.toast(exact ? `Scale set from ${Math.round(cm)} cm: camera height ${hcm} cm. Looks right saves it.` : `Camera height is at its limit (${hcm} cm): measure a longer length.`, { kind: exact ? 'ok' : 'info', id: 'ruler-scale', ms: 5000 })
    }
    trueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTrue() } })
    const trueRow = h('div.ws-adj-truerow', { hidden: true },
      h('span.ws-adj-true-cap', 'Know its real length?'), h('label.ws-adj-true-field', trueInput, h('span', 'cm')),
      h('button.ws-adj-btn', { type: 'button', dataset: { midstudy: 'ruler-set', tip: 'Scale the room so the ruler reads this length' }, onclick: applyTrue }, 'Set scale'))
    const reset = h('button.ws-adj-btn', { type: 'button', dataset: { midstudy: 'floor-reset', tip: 'Back to the automatic camera' }, onclick: () => engine.resetCamera() }, 'Reset')
    const ok = h('button.ws-adj-btn.is-primary', { type: 'button', dataset: { midstudy: 'floor-ok' }, onclick: () => quiet(looksRight()) }, 'Looks right')
    const close = h('button.ws-adj-close', { type: 'button', 'aria-label': 'Close Adjust floor', onclick: () => setAdjust(false) }, icon('close', { size: 16, stroke: 2 }))
    fill(adjustCard,
      h('div.ws-adj-top', h('div.ws-adj-titles', h('b', 'Adjust floor'), note), close),
      h('div.ws-adj-sliders',
        camSlider('cam-height', 'height_m', 'Camera height', 'cm', Math.round(hl * 100), Math.round(hh * 100), 1, (m) => Math.round(m * 100), (cm) => cm / 100, 0),
        camSlider('cam-fov', 'fov_y_deg', 'Field of view', '°', fl, fh, 0.5, (d) => Math.round(d * 2) / 2, (d) => d, 1),
        camSlider('cam-roll', 'roll_deg', 'Roll', '°', rl, rh, 0.1, (d) => Math.round(d * 10) / 10, (d) => d, 1)),
      trueRow,
      h('div.ws-adj-foot', h('div.ws-adj-tools', rulerBtn, rulerText, pitch), h('span.ws-spacer'), reset, ok))
    adjustCard.sync = () => {
      for (const r of Object.values(camRows)) if (r.isConnected) r.sync()
      const n = engine.getFloorNote()
      note.textContent = n && engine.getCameraSource() !== 'manual' ? n : 'Line the grid up with the floor: tiles, a rug, the foot of the walls. Drag the horizon line to tilt.'
      note.classList.toggle('is-warn', !!n && engine.getCameraSource() !== 'manual')
      pitch.textContent = `Tilt ${fmt1(engine.getCamera().pitch_deg)}°`
      const r = engine.getRuler()
      rulerBtn.setAttribute('aria-pressed', String(r.active))
      rulerText.textContent = r.active ? (r.meters != null ? `${Math.round(r.meters * 100)} cm` : r.points.length ? 'Tap the other end' : 'Tap two points on the floor') : ''
      const showTrue = r.active && r.meters != null
      if (trueRow.hidden === showTrue) { trueRow.hidden = !showTrue; requestAnimationFrame(syncStage) }
      reset.disabled = false
    }
    adjustCard.sync()
  }
  async function looksRight() {
    const before = engine.getSavedScene()
    try { await engine.saveScene() } catch { return }
    engine.setAdjustFloor(false)
    const src = engine.getCameraSource()
    shell.toast(src === 'manual' && before?.camera_source !== 'manual' ? 'Floor saved: your camera is used from now on.' : 'Floor saved.', { kind: 'ok', id: 'floor-saved', ms: 3000 })
  }
  function setAdjust(onFlag) {
    engine.setAdjustFloor(onFlag)
    if (onFlag && phone() && shell.getOpenPanel()) shell.closePanel()
  }

  // --- loading and empty cards -----------------------------------------------------------------------------------------
  function renderLoadCard() {
    const load = engine.getSceneLoad()
    const state = load.loading ? load.phase || 'photo' : ''
    root.dataset.ws = load.loading ? 'loading' : ''
    if (!set(loadCard, !!state)) { root.style.setProperty('--ws-thumb', 'none'); return }
    const s = load.scene || scenes.getScene(load.name)
    const bg = s?.thumb_url || s?.photo_url
    root.style.setProperty('--ws-thumb', bg ? `url("${bg}")` : 'none')
    const cal = state === 'calibrating'
    fill(loadCard,
      h('div.ws-lc-head', h('span.ws-lc-cap', cal ? 'Calibrating' : 'Opening scene'), h('h2.ws-lc-title', s ? sceneTitle(s) : 'Scene'),
        h('span.ws-lc-meta', cal ? (s?.photo_url ? 'Finding the floor and the camera in the photo…' : 'Reading the photo…') : 'Loading the photo…')),
      h('div.ws-lc-progress', h('div.ws-lc-bar.is-indeterminate', h('span'))),
      h('div.ws-lc-actions', h('button.ws-lc-btn', { type: 'button', onclick: () => { engine.closeScene(); shell.openPage('scenes') } }, h('span', 'Back to scenes'))))
  }
  function renderEmpty() {
    const show = !engine.getSceneName() && !engine.getSceneLoad().loading && !shell.getOpenPage()
    if (!set(emptyCard, show) || emptyCard.childElementCount) return
    fill(emptyCard,
      h('span.ws-empty-ic', glyph(G.scenes, 28, 20, 1.4)),
      h('h2', 'No scene open'),
      h('p', 'A scene is one photo of a room. Open one, or take a new photo of the room you want to furnish.'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => shell.openPage('scenes') }, 'Open scenes'))
  }

  // --- gesture hint (phone, once per device) ------------------------------------------------------------------------------
  function renderHint() {
    const want = phone() && store.get(HINT_KEY) !== '1' && !!engine.getSceneName() && !busy() && !engine.getAdjustFloor() && !engine.getSelected() && !shell.getOpenPanel() && !shell.getOpenPage()
    if (!set(hint, want) || hint.childElementCount) return
    const row = (ic, a, b) => h('div.ws-hint-row', h('span.ws-hint-ic', fromHtml(`<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic}</svg>`)), h('div', h('b', a), h('span', b)))
    hint.append(
      h('div.ws-hint-head', h('b', 'Placing furniture'), h('button.ws-hint-ok', { type: 'button', onclick: () => { store.set(HINT_KEY, '1'); hint.hidden = true; syncStage() } }, 'Got it')),
      row('<circle cx="14" cy="14" r="9" stroke="#D9A441" stroke-width="1.5" stroke-dasharray="2.5 3"/><circle cx="14" cy="14" r="4" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/>', 'Tap a piece', 'Then drag it across the floor'),
      row('<circle cx="10" cy="15" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><circle cx="18" cy="11" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><path d="M6 19l-2.5 2.5M3.5 18.5v3h3M22 7l2.5-2.5M24.5 7.5v-3h-3" stroke="#D9A441" stroke-width="1.5"/>', 'Two fingers', 'Pinch to zoom into the photo, drag to pan'))
  }

  // --- the stage: the part of the window the photo fits into -----------------------------------------------------------
  function syncStage() {
    const m = shell.metrics()
    if (m.mode === 'desktop') {
      const adj = !adjustCard.hidden ? adjustCard.offsetHeight + 24 : 0
      engine.setStageInsets({ left: m.chromeLeft, top: 52, right: 0, bottom: adj })
      return
    }
    const top = m.safe.top + 60
    const sheet = shell.getOpenPanel()
    let bottom
    if (sheet && sheet.detent !== 'full') bottom = m.sheetH
    else if (!adjustCard.hidden) bottom = adjustCard.offsetHeight + m.safe.bottom + 16
    else bottom = m.safe.bottom + 8 + 64 + 8 + 56 + 8
    engine.setStageInsets({ left: 0, top, right: 0, bottom })
  }

  // --- the whole chrome from the current state ----------------------------------------------------------------------------
  function sync() {
    const sel = engine.getSelected()
    const open = !!engine.getSceneName()
    const adj = engine.getAdjustFloor()
    renderSwitcher()
    renderChips()
    renderLoadCard()
    renderEmpty()
    syncTools()
    const showSel = !!sel && open && !adj && !busy()
    const it = sel ? engine.getItem(sel) : null
    const selSig = `${sel}|${it?.missing ? 1 : 0}|${it?.noGlb ? 1 : 0}|${shell.mode}`
    if (set(selBar, showSel) && (!selBar.childElementCount || selBar.dataset.sig !== selSig)) { selBar.dataset.sig = selSig; buildSelBar() }
    if (!showSel) { selBar.dataset.sig = ''; lift.replaceChildren(); elevInputs.clear(); dropBtns.clear() }
    set(lift, showSel && phone())
    if (showSel) syncElev()
    const wasAdj = !adjustCard.hidden
    if (set(adjustCard, adj && open && !busy())) {
      if (!adjustCard.childElementCount || adjustCard.dataset.mode !== shell.mode) { adjustCard.dataset.mode = shell.mode; buildAdjust() }
      adjustCard.sync()
    } else if (wasAdj) { adjustCard.replaceChildren(); adjustCard.dataset.mode = '' }
    toolRow.hidden = !phone() || showSel || (adj && open) || !open
    root.dataset.wsBar = phone() ? (adj && open ? 'adjust' : showSel ? 'select' : '') : ''
    root.dataset.wsAdjust = adj && open ? '1' : ''
    renderHint()
    if (wasAdj !== !adjustCard.hidden) requestAnimationFrame(syncStage)
  }
  const rebuild = () => { buildTools(); selBar.replaceChildren(); lift.replaceChildren(); adjustCard.replaceChildren(); hint.replaceChildren(); emptyCard.replaceChildren(); sync(); syncStage() }

  for (const ev of ['scene', 'dirty', 'selection', 'adjust', 'occlusion', 'grid', 'look', 'layouts']) on(engine.events, ev, sync)
  on(engine.events, 'items', (e) => { if (e.detail.change !== 'move') sync(); else if (e.detail.uid === engine.getSelected()) syncElev() })
  on(engine.events, 'camera', () => { if (!adjustCard.hidden) adjustCard.sync?.(); renderSwitcher() })
  on(engine.events, 'ruler', () => { if (!adjustCard.hidden) adjustCard.sync?.() })
  on(engine.events, 'view', syncTools)
  on(engine.events, 'adjust', (e) => { if (e.detail.on && phone()) { const p = shell.getOpenPanel(); if (p) shell.closePanel() } })
  for (const ev of ['scenes']) on(scenes.events, ev, () => { renderSwitcher(); if (!loadCard.hidden) renderLoadCard(); renderEmpty() })
  on(shell.events, 'mode', rebuild)
  on(shell.events, 'page', () => { sync() })
  on(shell.events, 'layout', () => syncStage())
  on(shell.events, 'panel', () => { sync(); syncStage() })

  // --- keys: Del with Undo, ⌘Z, Esc leaves Adjust floor -------------------------------------------------------------------
  shell.addKeyFilter((e) => {
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false
    if ((e.key === 'Delete' || e.key === 'Backspace') && engine.getSelected() && !e.metaKey && !e.ctrlKey) { e.preventDefault(); removeSelected(); return true }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && lastRemoved) { e.preventDefault(); const l = lastRemoved; lastRemoved = null; l.toast?.close(); l.undo(); return true }
    if (e.key === 'Escape' && engine.getAdjustFloor() && !engine.getRuler().active) { e.preventDefault(); setAdjust(false); return true }
    return false
  })

  // --- the grip: drag around the item's center to rotate it (15° steps on touch, Shift on desktop) -------------------------
  grip.addEventListener('pointerdown', (e) => {
    const uid = engine.getSelected()
    if (!uid || !engine.beginRotateDrag(uid, e.clientX, e.clientY)) return
    e.preventDefault()
    grip.setPointerCapture?.(e.pointerId)
    grip.dataset.touch = e.pointerType !== 'mouse' ? '1' : ''
  })
  grip.addEventListener('pointermove', (e) => { if (engine.getDrag()?.mode === 'rotate') engine.dragTo(e.clientX, e.clientY, { snapTo: grip.dataset.touch === '1' }) })
  const gripUp = () => { if (engine.getDrag()?.mode === 'rotate') engine.endItemDrag() }
  grip.addEventListener('pointerup', gripUp)
  grip.addEventListener('pointercancel', gripUp)
  grip.addEventListener('click', (e) => { if (e.detail === 0) engine.rotateSelected(15) }) // keyboard activation

  // --- the horizon handle: drag it up or down to set the pitch -----------------------------------------------------------
  let hz = null // { id, y0, py0 }
  horizonHandle.addEventListener('pointerdown', (e) => {
    if (!engine.getAdjustFloor()) return
    e.preventDefault()
    horizonHandle.setPointerCapture?.(e.pointerId)
    const ph = engine.getPhotoSize()
    hz = { id: e.pointerId, y0: e.clientY, py0: engine.horizonAt(ph.w / 2) ?? ph.h / 2 }
    horizonHandle.classList.add('is-active')
  })
  horizonHandle.addEventListener('pointermove', (e) => {
    if (!hz || e.pointerId !== hz.id) return
    const rect = engine.getPhotoRect()
    const s = rect.w / engine.getPhotoSize().w
    // The line follows the finger, except on a small photo (the phone at Fit: about 0.4° a pixel), where the tilt
    // moves at most HORIZON_FINE degrees per CSS pixel: drag further for the same change, so it can be set finely.
    const degPerPx = (360 / Math.PI) * Math.tan((engine.getCamera().fov_y_deg * Math.PI) / 360) / Math.max(1, rect.h) // 1 / focal, in ° per CSS px
    const gain = Math.min(1, HORIZON_FINE / degPerPx)
    engine.setPitchFromHorizon(hz.py0 + ((e.clientY - hz.y0) / s) * gain)
  })
  const hzUp = () => { hz = null; horizonHandle.classList.remove('is-active') }
  horizonHandle.addEventListener('pointerup', hzUp)
  horizonHandle.addEventListener('pointercancel', hzUp)
  horizonHandle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); engine.setCamera({ pitch_deg: engine.getCamera().pitch_deg + (e.key === 'ArrowUp' ? 0.25 : -0.25) }) }
  })
  horizonHandle.tabIndex = 0

  // --- ruler handles: drag a point along the floor ------------------------------------------------------------------------
  let rDrag = null
  handles.forEach((el, i) => {
    el.addEventListener('pointerdown', (e) => {
      if (!engine.getRuler().active) return
      e.preventDefault()
      el.setPointerCapture?.(e.pointerId)
      rDrag = { i, touch: e.pointerType !== 'mouse' }
    })
    el.addEventListener('pointermove', (e) => { if (rDrag?.i === i) engine.setRulerPointAt(i, e.clientX, e.clientY - (rDrag.touch ? 30 : 0)) })
    const up = () => { if (rDrag?.i === i) rDrag = null }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })

  // --- per frame: place the overlay -------------------------------------------------------------------------------------
  const px = (el, x, y) => { el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)` }
  const hide = (...els) => { for (const el of els) if (!el.hidden) el.hidden = true }
  const vw = () => window.innerWidth, vh = () => window.innerHeight
  const line = (el, a, b) => { el.setAttribute('x1', a[0].toFixed(1)); el.setAttribute('y1', a[1].toFixed(1)); el.setAttribute('x2', b[0].toFixed(1)); el.setAttribute('y2', b[1].toFixed(1)) }
  let clipKey = ''
  function drawFrame() {
    const sel = engine.getSelected()
    const adj = engine.getAdjustFloor()
    const showSel = sel && !busy() && !adj
    // The footprint, guide, horizon and ruler lines stay on the photo, never over the letterbox bars or the chrome.
    if (engine.getSceneName()) {
      const r = engine.getVisiblePhotoRect()
      const key = `inset(${Math.round(r.y)}px ${Math.round(vw() - r.x - r.w)}px ${Math.round(vh() - r.y - r.h)}px ${Math.round(r.x)}px)`
      if (key !== clipKey) { clipKey = key; svg.style.clipPath = key }
    }
    // selection footprint, label, grip
    const f = showSel ? engine.getFootprint(sel) : null
    const s = f ? f.corners.map((c) => engine.worldToScreen(c)) : null
    if (s && s.every((p) => p.visible)) {
      fpPoly.setAttribute('points', s.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
      const c = s.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 })
      const fr = s[1]
      let dx = fr.x - c.x, dy = fr.y - c.y
      const len = Math.hypot(dx, dy) || 1
      dx /= len; dy /= len
      line(fpStem, [fr.x, fr.y], [fr.x + dx * 11, fr.y + dy * 11])
      // The grip sits off the front-right corner, but always on the visible photo and clear of the selection bar and
      // the phone's lift column, so it can be grabbed when the piece is close to the camera (its corner off the photo).
      const vr = engine.getVisiblePhotoRect()
      const barTop0 = selBar.hidden ? vh() : selBar.getBoundingClientRect().top
      const liftR = lift.hidden ? null : lift.getBoundingClientRect()
      const maxX = Math.min(vr.x + vr.w, vw(), liftR && liftR.width ? liftR.left - 4 : Infinity) - 46
      const maxY = Math.min(vr.y + vr.h, vh(), barTop0 - 6) - 46
      const gx = Math.max(Math.max(vr.x, 0) + 2, Math.min(maxX, fr.x + dx * 24 - 22))
      const gy = Math.max(Math.max(vr.y, 0) + 2, Math.min(maxY, fr.y + dy * 24 - 22))
      px(grip, gx, gy)
      const it = engine.getItem(sel)
      const up = Math.round(it.position[1] * 100)
      const where = up > 0 ? `${up} cm up` : ''
      const text = `${it.name}|${dimsText(it.lib?.dims_cm)}|${where}|${it.missing ? 1 : 0}`
      if (label.dataset.text !== text) {
        label.dataset.text = text
        fill(label, h('b', it.missing ? `${it.name} · missing` : it.name), it.lib?.dims_cm ? h('span', dimsText(it.lib.dims_cm)) : null, where ? h('span.ws-label-up', where) : null)
      }
      if (it.position[1] > 0.02) {
        const top = engine.worldToScreen([f.center[0], it.position[1], f.center[2]]), foot = engine.worldToScreen([f.center[0], 0, f.center[2]])
        if (top.visible && foot.visible) {
          line(guide, [top.x, top.y], [foot.x, foot.y])
          guideDot.setAttribute('cx', foot.x.toFixed(1)); guideDot.setAttribute('cy', foot.y.toFixed(1))
          guide.style.display = guideDot.style.display = ''
        } else guide.style.display = guideDot.style.display = 'none'
      } else guide.style.display = guideDot.style.display = 'none'
      const lx = Math.min(s[0].x, s[1].x), lw = label.offsetWidth || 140, lh = label.offsetHeight || 40
      let ly = Math.max(...s.map((p) => p.y)) + 10
      if (lx < gx + 40 && lx + lw > gx + 4 && ly < gy + 38) ly = gy + 38 // keep the grip clear
      const barTop = selBar.hidden ? vh() : selBar.getBoundingClientRect().top
      if (ly + lh > barTop - 8) { // no room below: above the piece's top instead
        const top = Math.min(...f.box.map((p) => engine.worldToScreen(p).y))
        ly = top - lh - 10
      }
      px(label, Math.max(8, Math.min(vw() - lw - 8, lx)), Math.max(8, Math.min(vh() - lh - 8, ly)))
      fpPoly.style.display = fpStem.style.display = ''
      label.hidden = grip.hidden = false
    } else {
      fpPoly.style.display = fpStem.style.display = 'none'
      guide.style.display = guideDot.style.display = 'none'
      hide(label, grip)
    }
    drawHorizon(adj && !busy())
    drawRuler(adj && !busy())
  }
  engine.onFrame(drawFrame)
  // The horizon line across the photo, and its handle at the photo's centre column (kept inside the visible area,
  // with an arrow when the horizon itself is above or below it).
  function drawHorizon(show) {
    const ph = engine.getPhotoSize()
    const y0 = show ? engine.horizonAt(0) : null, y1 = show ? engine.horizonAt(ph.w) : null
    if (!show || y0 == null || y1 == null) { horizonLine.style.display = horizonShadow.style.display = 'none'; hide(horizonHandle, horizonTag); return }
    const a = engine.photoToClient(0, y0), b = engine.photoToClient(ph.w, y1)
    line(horizonLine, a, b)
    line(horizonShadow, a, b)
    horizonLine.style.display = horizonShadow.style.display = ''
    const st = engine.getVisiblePhotoRect()
    const c = engine.photoToClient(ph.w / 2, engine.horizonAt(ph.w / 2))
    const cy = Math.max(st.y + 24, Math.min(st.y + st.h - 24, c[1]))
    const cx = Math.max(st.x + 24, Math.min(st.x + st.w - 24, c[0]))
    px(horizonHandle, cx - 22, cy - 22)
    horizonHandle.hidden = false
    const off = c[1] < st.y + 24 ? 'above' : c[1] > st.y + st.h - 24 ? 'below' : ''
    horizonHandle.dataset.off = off
    const txt = off ? `Horizon ${off} the photo` : 'Horizon'
    if (horizonTag.textContent !== txt) horizonTag.textContent = txt
    px(horizonTag, cx + 26, cy - 13)
    horizonTag.hidden = false
  }
  function drawRuler(show) {
    const r = show ? engine.getRuler() : null
    const sp = r?.active ? r.points.map((p) => engine.worldToScreen(p)) : []
    handles.forEach((el, i) => { const p = sp[i]; if (p && p.visible) { px(el, p.x - 22, p.y - 22); el.hidden = false } else el.hidden = true })
    if (sp.length === 2 && sp.every((p) => p.visible)) {
      line(rulerLine, [sp[0].x, sp[0].y], [sp[1].x, sp[1].y])
      line(rulerShadow, [sp[0].x, sp[0].y], [sp[1].x, sp[1].y])
      rulerLine.style.display = rulerShadow.style.display = ''
      const txt = `${Math.round(r.meters * 100)} cm`
      if (pill.dataset.text !== txt) { pill.dataset.text = txt; fill(pill, h('b', txt)) }
      const pw = pill.offsetWidth || 70
      px(pill, (sp[0].x + sp[1].x) / 2 - pw / 2, (sp[0].y + sp[1].y) / 2 - 38)
      pill.hidden = false
    } else {
      rulerLine.style.display = rulerShadow.style.display = 'none'
      pill.hidden = true
    }
  }

  // --- keyboard inset (phone): cards ride above the keyboard ---------------------------------------------------------------
  const vv = window.visualViewport
  function syncKb() {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    root.style.setProperty('--kb', `${Math.round(kb)}px`)
    root.dataset.kb = kb > 80 ? 'up' : ''
  }
  vv?.addEventListener('resize', syncKb)
  vv?.addEventListener('scroll', syncKb)
  syncKb()

  ctx.workspace = { requestRender, setAdjust }
  buildTools()
  sync()
  syncStage()
}
