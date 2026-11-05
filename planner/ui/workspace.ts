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
// ctx.workspace: { setAdjust(on) } (the Scene panel's Adjust floor… button)
// Shell events it sends (cancelable; preventDefault() to take over): 'render-request' {}, 'open-render' { meta }
// The decisions, placements and words: logic/workspace.ts.
import { ring, unsavedGlyph, icon, svgFrom } from './icons.js'
import { dimsText, horizonDragGain, horizonDragRow, quiet, sceneTitle, MAX_ELEVATION, CAMERA_RANGE, type CameraKey, type CameraPatch, type ItemSnapshot, type UiContext } from './seam.js'
import type { Child } from './kit.js'
import type { ToastHandle } from './shell.js'
import { keyboardInset } from './logic/chrome.js'
import { fixedMinus, readDecimal, readSigned, signed1 } from './logic/text.js'
import {
  adjustNote, bottomBar, clipInset, elevCm as cmOf, elevMeters, fillPercent, floorSavedText, frontCorner, gripSpot, horizonHandle as handleSpot,
  labelSpot, missingText, renderChip, repeatCm, repeatDelayMs, rulerHint as rulerHintText, scaleText, stageInsets, switcher as switcherOf, switcherLabel, upText,
  workspaceKey, type Pt, type Rect,
} from './logic/workspace.js'

const NS = 'http://www.w3.org/2000/svg'
const isList = (c: Child): c is readonly Child[] => Array.isArray(c)
// el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false)), as v1 filled its parts.
const fill = (el: Element, ...kids: Child[]): void => { el.replaceChildren(...flatKids(kids)) }
function flatKids(kids: readonly Child[], out: (Node | string)[] = []): (Node | string)[] {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue
    if (isList(k)) flatKids(k, out)
    else out.push(k instanceof Node ? k : String(k))
  }
  return out
}
const glyph = (body: string, size = 20, vb = 20, sw = 1.5): SVGSVGElement => svgFrom(`<svg class="icon" width="${String(size)}" height="${String(size)}" viewBox="0 0 ${String(vb)} ${String(vb)}" fill="none" stroke="currentColor" stroke-width="${String(sw)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`)
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
const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
// eslint-disable-next-line @typescript-eslint/no-deprecated -- v1 reads navigator.platform first to tell a Mac (⌘Z, not Ctrl Z)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function cameraPatch(key: CameraKey, v: number): CameraPatch {
  switch (key) {
    case 'height_m': return { height_m: v }
    case 'fov_y_deg': return { fov_y_deg: v }
    case 'pitch_deg': return { pitch_deg: v }
    case 'roll_deg': return { roll_deg: v }
  }
}

/** @public planner/main.js mounts every area: mod.mount(ctx). */
export function mount(ctx: UiContext): void {
  const { engine, scenes, shell, kit } = ctx
  const { h, kbd } = kit
  const root = document.documentElement
  const phone = (): boolean => shell.isPhone()
  let rendering: { readonly t0: number } | null = null    // while a render runs
  let lastRemoved: { readonly snap: ItemSnapshot; readonly toast: ToastHandle; readonly undo: () => void } | null = null  // for Undo / ⌘Z

  // --- top bar ---------------------------------------------------------------------------------------------------
  const switcher = h('button.ws-switcher', { type: 'button', 'aria-label': 'Scenes', dataset: { tip: 'All scenes' }, onclick: () => { shell.openPage('scenes') } })
  const chips = h('div.ws-chips')
  const left = h('div.ws-top-left', switcher, chips)
  const right = h('div.ws-top-right')
  shell.mounts.topbar.append(left, right)
  const toolRow = h('div.ws-tools', { role: 'toolbar', 'aria-label': 'Tools' })
  shell.mounts.rail.append(toolRow)

  // --- tools: one set, in the top bar (desktop) or the row above the dock (phone) ---------------------------------
  const tools = new Map<string, HTMLButtonElement>()
  function buildTools(): void {
    const desk = !phone()
    const mk = (id: string, g: string, label: string, tip: string, onclick: () => void, cls = ''): HTMLButtonElement => {
      const b = desk
        ? h(`button.ws-tool${cls}`, { type: 'button', onclick, dataset: { midstudy: id, tip } }, glyph(g, 16, 20, 1.75), h('span', label))
        : h(`button.ws-tl${cls}`, { type: 'button', onclick, 'aria-label': tip, dataset: { midstudy: id } }, glyph(g, 22, 20, 1.6), h('span', label))
      tools.set(id, b)
      return b
    }
    const adjust = mk('adjust-floor', G.floor, 'Adjust floor', 'Line the grid up with the floor', () => { setAdjust(!engine.getAdjustFloor()) })
    const occl = mk('occlusion', G.occl, 'Occlusion', 'Hide furniture behind things in the photo', () => { toggleOcclusion() })
    const fit = mk('zoom-fit', G.fit, 'Fit', 'Fit the photo (pinch or scroll to zoom)', () => { engine.fitView() })
    const render = mk('render', '<path d="M9 3l1.5 4.5L15 9l-4.5 1.5L9 15l-1.5-4.5L3 9l4.5-1.5z"/><path d="M15.5 13v4M13.5 15h4"/>', 'Render', 'Render a photoreal image (paid)', () => { requestRender() }, '.is-strong')
    fill(right)
    fill(toolRow)
    if (desk) fill(right, adjust, occl, h('span.ws-divider'), fit, h('span.ws-divider'), render)
    else fill(toolRow, adjust, occl, fit, render)
    syncTools()
  }
  function syncTools(): void {
    const open = !!engine.getSceneName()
    for (const b of tools.values()) b.disabled = !open
    tools.get('adjust-floor')?.setAttribute('aria-pressed', String(engine.getAdjustFloor()))
    const st = engine.getScene()
    const occl = tools.get('occlusion')
    if (occl) {
      occl.setAttribute('aria-pressed', String(!!st && st.hasDepth && engine.getOcclusion()))
      occl.classList.toggle('is-unavailable', !!st && !st.hasDepth)
      if (!phone()) occl.dataset['tip'] = st && !st.hasDepth ? 'No depth for this photo: nothing in it hides furniture' : 'Hide furniture behind things in the photo'
    }
    const z = engine.getView().zoom
    const fit = tools.get('zoom-fit')
    if (fit) {
      const word = fit.lastChild
      if (word) word.textContent = z > 1.001 ? `${z.toFixed(1)}×` : 'Fit'
      fit.setAttribute('aria-pressed', String(z > 1.001))
    }
  }
  function toggleOcclusion(): void {
    const st = engine.getScene()
    if (st && !st.hasDepth) shell.toast('This photo has no depth map, so nothing in it can hide the furniture.', { id: 'no-depth', ms: 4000 })
    engine.setOcclusion(!engine.getOcclusion())
  }

  // --- render: request, chip, ready toast ----------------------------------------------------------------------------
  function requestRender(): void {
    if (!engine.getSceneName()) return
    if (!shell.events.emit('render-request', {}, true)) return // someone took it
    quiet(engine.renderViewInternal({}))
  }
  let renderTimer: ReturnType<typeof setInterval> | undefined
  engine.events.addEventListener('render', (e) => {
    const { phase, meta } = e.detail
    if (phase === 'start') {
      rendering = { t0: performance.now() }
      clearInterval(renderTimer)
      renderTimer = setInterval(renderChips, 1000)
    } else {
      rendering = null
      clearInterval(renderTimer)
      if (phase === 'done' && meta) shell.toast('Render ready', { kind: 'ok', id: 'render-ready', ms: 10000, action: { label: 'View', onClick: () => { if (shell.events.emit('open-render', { meta }, true)) shell.openPanel('renders') } } })
    }
    renderChips()
  })
  function renderChips(): void {
    if (!rendering) { fill(chips); return }
    const c = renderChip((performance.now() - rendering.t0) / 1000)
    const chip = h('span.ws-chip.is-rendering', h('span.ws-chip-glyph', ring(c.progress, { size: phone() ? 16 : 14 })), h('span.ws-chip-text', c.text))
    fill(chips, h('button.ws-chip-hit', { type: 'button', onclick: () => { shell.openPanel('renders') }, 'aria-label': 'Rendering' }, chip))
  }

  // --- the switcher -------------------------------------------------------------------------------------------------
  function renderSwitcher(): void {
    const name = engine.getSceneName()
    const load = engine.getSceneLoad()
    const s = switcherOf({
      loading: load.loading, calibrating: load.phase === 'calibrating', open: !!name,
      noScenesYet: scenes.getState().loaded && !scenes.getScenes().length,
      dirty: engine.isSceneDirty() || engine.isLayoutDirty(),
      checkFloor: !!engine.getFloorNote() && engine.getCameraSource() !== 'manual',
    })
    let title: string
    let g: Element
    if (s.state === 'loading') {
      const sc = load.scene ?? scenes.getScene(load.name)
      title = sc ? sceneTitle(sc) : 'Scene'
      g = ring(null, { size: 14, tone: 'text' })
    } else if (s.state === 'none') {
      title = 'Scenes'
      g = glyph(G.scenes, 16)
    } else {
      title = sceneTitle(engine.getScene() ?? scenes.getScene(name))
      g = s.state === 'unsaved' ? unsavedGlyph(14) : s.state === 'check' ? icon('warning', { size: 16, stroke: 1.75 }) : h('span.dot')
    }
    switcher.dataset['state'] = s.state
    const chevron = icon('chevron-down', { size: 16, stroke: 1.9 })
    chevron.classList.add('ws-chevron')
    fill(switcher, h('span.ws-sw-glyph', g), h('span.ws-sw-title', title), s.word ? h('span.ws-sw-word', s.word) : null, phone() && s.word ? null : chevron)
    switcher.setAttribute('aria-label', switcherLabel(title, s.word))
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
  const mk = (tag: string, attrs: Readonly<Record<string, string | number>>): SVGElement => {
    const e = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    return e
  }
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
  const handles = [0, 1].map((i) => h('div.ws-handle', { dataset: { i: String(i) }, hidden: true }, h('span')))
  shell.mounts.overlays.append(svg, label, grip, horizonHandle, horizonTag, pill, ...handles)

  // --- helpers --------------------------------------------------------------------------------------------------------
  const set = (el: HTMLElement, show: boolean): boolean => { el.hidden = !show; return show }
  const busy = (): boolean => engine.getSceneLoad().loading || !engine.getSceneName()

  // --- selection bar + height (§2.10) ------------------------------------------------------------------------------
  function removeSelected(): void {
    const uid = engine.getSelected()
    if (!uid) return
    const snap = engine.removeItemWithUndo(uid)
    if (!snap) return
    const undo = (): void => { if (lastRemoved?.snap === snap) lastRemoved = null; quiet(engine.restoreItem(snap)) }
    const t = shell.toast(`${snap.name} removed`, { id: `removed:${uid}`, icon: 'trash', ms: 6000, action: { label: 'Undo', onClick: undo } })
    if (!phone()) t.el.querySelector('.toast-action')?.append(kbd(isMac ? '⌘Z' : 'Ctrl Z'))
    lastRemoved = { snap, toast: t, undo }
  }
  function explainMissing(): void {
    const it = engine.getItem(engine.getSelected())
    shell.toast(missingText(it ? it.name : null, !!it?.noGlb), { id: 'missing-why', ms: 9000 })
  }
  const selUid = (): string | null => engine.getSelected()
  const elevCm = (): number => { const u = selUid(); return cmOf(u ? engine.getElevation(u) : 0) }
  const setElevCm = (v: number): void => { const u = selUid(); if (u) engine.setElevation(u, elevMeters(v)) }
  const nudge = (cm: number): void => { const u = selUid(); if (u) engine.nudgeElevation(u, cm / 100) }
  const raised = (): boolean => { const it = engine.getItem(selUid()); return !!it && it.position[1] > 0.0005 }
  function drop(): void { const u = selUid(); if (u) engine.dropToFloor(u) }
  // + / − : one cm a press (on pointer down, so a quick tap counts once), held repeats faster
  function holdBtn(cls: string, dir: 1 | -1, labelText: string, midstudyName: string, size: number): HTMLButtonElement {
    let t: ReturnType<typeof setTimeout> | undefined
    let n = 0
    const stop = (): void => { clearTimeout(t); t = undefined }
    let pressed = false
    return h(`button.${cls}`, {
      type: 'button', 'aria-label': labelText, dataset: { midstudy: midstudyName, tip: labelText, kbd: dir > 0 ? 'PgUp' : 'PgDn' },
      onpointerdown: (e) => {
        if (e.button) return
        pressed = true
        n = 0
        nudge(dir)
        const go = (): void => { n++; nudge(dir * repeatCm(n)); t = setTimeout(go, repeatDelayMs(n)) }
        t = setTimeout(go, 450)
      },
      onpointerup: stop, onpointerleave: stop, onpointercancel: stop, oncontextmenu: (e) => { e.preventDefault() },
      // a click without a pointer press (keyboard, or a script's element.click()) nudges once
      onclick: () => { if (!pressed) nudge(dir); pressed = false },
    }, icon(dir > 0 ? 'plus' : 'minus', { size }))
  }
  const elevInputs = new Set<HTMLInputElement>()
  function elevInput(cls: string): HTMLInputElement {
    const input = h(`input.${cls}.tnum`, { type: 'text', inputmode: 'numeric', enterkeyhint: 'done', autocomplete: 'off', spellcheck: false, 'aria-label': 'Height above the floor, cm', dataset: { midstudy: 'elev-value' } })
    const commit = (): void => {
      const v = readSigned(input.value)
      if (Number.isFinite(v)) setElevCm(v)
      input.value = String(elevCm())
    }
    input.addEventListener('change', commit)
    input.addEventListener('focus', () => { input.select() })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur() }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.value = String(elevCm()); input.blur() }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)) }
    })
    elevInputs.add(input)
    return input
  }
  const dropBtns = new Set<HTMLButtonElement>()
  function syncElev(): void {
    const cm = String(elevCm())
    for (const i of elevInputs) if (i.isConnected && document.activeElement !== i && i.value !== cm) i.value = cm
    for (const b of dropBtns) b.disabled = !raised()
  }
  function buildLift(): void {
    if (!phone()) { lift.replaceChildren(); return }
    const handle = h('div.ws-lift-grip', { role: 'slider', 'aria-label': 'Drag up or down to raise or lower', 'aria-valuemin': '0', 'aria-valuemax': String(MAX_ELEVATION * 100) }, h('i'), h('i'), h('i'))
    let d: { readonly id: number; readonly y0: number; readonly cm0: number } | null = null
    handle.addEventListener('pointerdown', (e) => { d = { id: e.pointerId, y0: e.clientY, cm0: elevCm() }; handle.setPointerCapture(e.pointerId); handle.classList.add('is-active'); e.preventDefault() })
    handle.addEventListener('pointermove', (e) => { if (d?.id === e.pointerId) setElevCm(d.cm0 + (d.y0 - e.clientY) / 2) })
    const end = (): void => { d = null; handle.classList.remove('is-active') }
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
  function buildSelBar(): void {
    elevInputs.clear()
    dropBtns.clear()
    const sel = engine.getItem(selUid())
    const missing = !!sel?.missing || !!sel?.noGlb
    if (phone()) {
      const it = (g: Element, text: string, onclick: () => void, cls = '', ds: Readonly<Record<string, string>> | null = null): HTMLButtonElement =>
        h(`button.ws-sb-item${cls}`, { type: 'button', onclick, dataset: ds }, g, h('span', text))
      fill(selBar,
        missing ? it(icon('warning'), sel.noGlb ? 'No GLB' : 'Missing', explainMissing, '.is-narrow.is-missing', { midstudy: 'missing-item' }) : null,
        it(glyph(G.rotL), '−15°', () => { engine.rotateSelected(-15) }),
        it(glyph(G.rotR), '+15°', () => { engine.rotateSelected(15) }),
        it(glyph(G.trash), 'Remove', removeSelected, '.is-narrow.is-danger'),
        h('span.ws-spacer'),
        h('button.ws-done', { type: 'button', onclick: () => { engine.select(null) } }, 'Done'))
      buildLift()
    } else {
      // (v1 sets data-kbd from `null` for Drop to floor, so its tooltip shows a "null" keycap; kept as it was.)
      const it = (g: Element, text: string, key: string | null, tip: string, onclick: () => void, cls = ''): HTMLButtonElement =>
        h(`button.ws-sb-item${cls}`, { type: 'button', onclick, dataset: { tip, kbd: key } }, g, text ? h('span', text) : null, key ? kbd(key) : null)
      const dropB = it(icon('drop', { size: 16, stroke: 1.75 }), 'Drop to floor', null, 'Back down to the floor', drop)
      dropB.dataset['midstudy'] = 'drop'
      dropBtns.add(dropB)
      fill(selBar,
        missing ? h('button.ws-missing', { type: 'button', dataset: { midstudy: 'missing-item', tip: sel.noGlb ? 'No GLB model: shown as a box at its size' : 'Removed from the library: shown as a box at its size' }, onclick: explainMissing }, icon('warning', { size: 16, stroke: 1.75 }), h('span', sel.noGlb ? 'No GLB' : 'Missing item')) : null,
        missing ? h('span.ws-divider') : null,
        it(glyph(G.rotL, 16, 20, 1.6), '−15°', '⇧R', 'Rotate back 15°', () => { engine.rotateSelected(-15) }),
        it(glyph(G.rotR, 16, 20, 1.6), '+15°', 'R', 'Rotate 15°', () => { engine.rotateSelected(15) }),
        h('span.ws-divider'),
        h('div.ws-elev', { role: 'group', 'aria-label': 'Height above the floor', dataset: { tip: 'Height above the floor · Shift+drag, PageUp / PageDown' } },
          h('span.ws-elev-cap', 'Height'),
          holdBtn('ws-elev-btn', -1, 'Down 1 cm', 'elev-down', 16),
          h('label.ws-elev-field', elevInput('ws-elev-input'), h('span', 'cm')),
          holdBtn('ws-elev-btn', 1, 'Up 1 cm', 'elev-up', 16)),
        dropB,
        h('span.ws-divider'),
        it(glyph(G.trash, 16, 20, 1.6), 'Remove', 'Del', 'Remove from the scene', removeSelected, '.is-danger'),
        h('button.ws-done', { type: 'button', onclick: () => { engine.select(null) }, dataset: { tip: 'Deselect' } }, h('span', 'Done'), h('kbd.kbd.is-ink', 'Esc')))
      lift.replaceChildren()
    }
    syncElev()
  }

  // --- Adjust floor (§4.5) -------------------------------------------------------------------------------------------
  // Sliders for the camera height (cm), field of view (°) and roll (°); the horizon line sets the pitch; an optional
  // two-tap ruler; Reset (back to the automatic camera) and Looks right (save; manual if anything changed).
  const camRows = new Map<string, { readonly row: HTMLLabelElement; readonly sync: () => void }>()
  let adjustSync: (() => void) | null = null
  function camSlider(id: string, key: CameraKey, text: string, unit: string, min: number, max: number, step: number, toUi: (v: number) => number, fromUi: (v: number) => number, digits: number): HTMLLabelElement {
    const out = h('span.ws-adj-value.tnum')
    const input = h('input.slider', { type: 'range', min, max, step, 'aria-label': text, dataset: { midstudy: id } })
    const apply = (): void => { const v = Number(input.value); if (Number.isFinite(v)) engine.setCamera(cameraPatch(key, fromUi(v))) }
    input.addEventListener('input', apply)
    input.addEventListener('change', apply)
    const row = h('label.ws-adj-row', h('span.ws-adj-head', h('span.ws-adj-label', text), out), input)
    const sync = (): void => {
      const v = toUi(engine.getCamera()[key])
      if (document.activeElement !== input || input.value !== String(v)) input.value = String(v)
      input.style.setProperty('--fill', fillPercent(v, min, max))
      out.textContent = `${fixedMinus(v, digits)} ${unit}`
    }
    camRows.set(id, { row, sync })
    return row
  }
  function buildAdjust(): void {
    const [hl, hh] = CAMERA_RANGE.height_m
    const [fl, fh] = CAMERA_RANGE.fov_y_deg
    const [rl, rh] = CAMERA_RANGE.roll_deg
    const note = h('p.ws-adj-note')
    const pitch = h('span.ws-adj-pitch.tnum')
    const rulerBtn = h('button.ws-adj-btn.is-quiet', { type: 'button', 'aria-pressed': 'false', onclick: () => { engine.setRulerActive(!engine.getRuler().active) } }, glyph(G.ruler, 18), h('span', 'Ruler'))
    const rulerText = h('span.ws-adj-ruler.tnum')
    // A known length fixes the scale: "[ ] cm · Set scale" scales the camera height (engine.setRulerTrueLength).
    const trueInput = h('input.input.ws-adj-true.tnum', { type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off', spellcheck: false, placeholder: phone() ? 'Real length' : 'e.g. 200', 'aria-label': 'Its real length, cm', dataset: { midstudy: 'ruler-true' } })
    const applyTrue = (): void => {
      const cm = readDecimal(trueInput.value)
      if (!(cm > 0)) { trueInput.focus(); return }
      const exact = engine.setRulerTrueLength(cm / 100)
      trueInput.value = ''
      trueInput.blur()
      const hcm = Math.round(engine.getCamera().height_m * 100)
      shell.toast(scaleText(exact, cm, hcm), { kind: exact ? 'ok' : 'info', id: 'ruler-scale', ms: 5000 })
    }
    trueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTrue() } })
    // The ruler's row shows while the ruler is on, at one fixed height: the instruction until two points are down, then
    // "Know its real length? [ ] cm · Set scale". So the card (and with it the photo above) doesn't move between the
    // taps, and on the phone the instruction has a whole line instead of hiding behind Reset.
    const rulerHint = h('span.ws-adj-rhint', { role: 'status' })
    const trueBox = h('div.ws-adj-truebox', { hidden: true },
      h('span.ws-adj-true-cap', 'Know its real length?'), h('label.ws-adj-true-field', trueInput, h('span', 'cm')),
      h('button.ws-adj-btn', { type: 'button', dataset: { midstudy: 'ruler-set', tip: 'Scale the room so the ruler reads this length' }, onclick: applyTrue }, 'Set scale'))
    const trueRow = h('div.ws-adj-truerow', { hidden: true }, rulerHint, trueBox)
    const reset = h('button.ws-adj-btn', { type: 'button', dataset: { midstudy: 'floor-reset', tip: 'Back to the automatic camera' }, onclick: () => { engine.resetCamera() } }, 'Reset')
    const ok = h('button.ws-adj-btn.is-primary', { type: 'button', dataset: { midstudy: 'floor-ok' }, onclick: () => { quiet(looksRight()) } }, 'Looks right')
    const close = h('button.ws-adj-close', { type: 'button', 'aria-label': 'Close Adjust floor', onclick: () => { setAdjust(false) } }, icon('close', { size: 16, stroke: 2 }))
    fill(adjustCard,
      h('div.ws-adj-top', h('div.ws-adj-titles', h('b', 'Adjust floor'), note), close),
      h('div.ws-adj-sliders',
        camSlider('cam-height', 'height_m', 'Camera height', 'cm', Math.round(hl * 100), Math.round(hh * 100), 1, (m) => Math.round(m * 100), (cm) => cm / 100, 0),
        camSlider('cam-fov', 'fov_y_deg', 'Field of view', '°', fl, fh, 0.5, (d) => Math.round(d * 2) / 2, (d) => d, 1),
        camSlider('cam-roll', 'roll_deg', 'Roll', '°', rl, rh, 0.1, (d) => Math.round(d * 10) / 10, (d) => d, 1)),
      trueRow,
      h('div.ws-adj-foot', h('div.ws-adj-tools', rulerBtn, rulerText, pitch), h('span.ws-spacer'), reset, ok))
    adjustSync = () => {
      for (const r of camRows.values()) if (r.row.isConnected) r.sync()
      const n = engine.getFloorNote()
      const manual = engine.getCameraSource() === 'manual'
      note.textContent = adjustNote(n, manual)
      note.classList.toggle('is-warn', !!n && !manual)
      pitch.textContent = `Tilt ${signed1(engine.getCamera().pitch_deg)}°`
      const r = engine.getRuler()
      rulerBtn.setAttribute('aria-pressed', String(r.active))
      rulerText.textContent = r.active && r.meters !== null ? `${String(Math.round(r.meters * 100))} cm` : ''
      const measured = r.active && r.meters !== null
      rulerHint.textContent = rulerHintText(r.active, measured, r.points.length, phone())
      rulerHint.hidden = measured
      trueBox.hidden = !measured
      if (trueRow.hidden === r.active) { trueRow.hidden = !r.active; requestAnimationFrame(syncStage) }
      reset.disabled = false
    }
    adjustSync()
  }
  async function looksRight(): Promise<void> {
    const before = engine.getSavedScene()
    try { await engine.saveScene() } catch { return }
    engine.setAdjustFloor(false)
    const src = engine.getCameraSource()
    shell.toast(floorSavedText(src === 'manual', before?.camera_source === 'manual'), { kind: 'ok', id: 'floor-saved', ms: 3000 })
  }
  function setAdjust(onFlag: boolean): void {
    engine.setAdjustFloor(onFlag)
    if (onFlag && phone() && shell.getOpenPanel()) shell.closePanel()
  }

  // --- loading and empty cards -----------------------------------------------------------------------------------------
  function renderLoadCard(): void {
    const load = engine.getSceneLoad()
    const state = load.loading ? (load.phase ?? '') || 'photo' : ''
    root.dataset['ws'] = load.loading ? 'loading' : ''
    if (!set(loadCard, !!state)) { root.style.setProperty('--ws-thumb', 'none'); return }
    const s = load.scene ?? scenes.getScene(load.name)
    const bg = (s?.thumb_url ?? '') || s?.photo_url
    root.style.setProperty('--ws-thumb', bg ? `url("${bg}")` : 'none')
    const cal = state === 'calibrating'
    fill(loadCard,
      h('div.ws-lc-head', h('span.ws-lc-cap', cal ? 'Calibrating' : 'Opening scene'), h('h2.ws-lc-title', s ? sceneTitle(s) : 'Scene'),
        h('span.ws-lc-meta', cal ? (s?.photo_url ? 'Finding the floor and the camera in the photo…' : 'Reading the photo…') : 'Loading the photo…')),
      h('div.ws-lc-progress', h('div.ws-lc-bar.is-indeterminate', h('span'))),
      h('div.ws-lc-actions', h('button.ws-lc-btn', { type: 'button', onclick: () => { engine.closeScene(); shell.openPage('scenes') } }, h('span', 'Back to scenes'))))
  }
  function renderEmpty(): void {
    const show = !engine.getSceneName() && !engine.getSceneLoad().loading && !shell.getOpenPage()
    if (!set(emptyCard, show) || emptyCard.childElementCount) return
    fill(emptyCard,
      h('span.ws-empty-ic', glyph(G.scenes, 28, 20, 1.4)),
      h('h2', 'No scene open'),
      h('p', 'A scene is one photo of a room. Open one, or take a new photo of the room you want to furnish.'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => { shell.openPage('scenes') } }, 'Open scenes'))
  }

  // --- gesture hint (phone, once per device) ------------------------------------------------------------------------------
  function renderHint(): void {
    const want = phone() && store.get(HINT_KEY) !== '1' && !!engine.getSceneName() && !busy() && !engine.getAdjustFloor() && !engine.getSelected() && !shell.getOpenPanel() && !shell.getOpenPage()
    if (!set(hint, want) || hint.childElementCount) return
    const row = (ic: string, a: string, b: string): HTMLDivElement => h('div.ws-hint-row', h('span.ws-hint-ic', svgFrom(`<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic}</svg>`)), h('div', h('b', a), h('span', b)))
    hint.append(
      h('div.ws-hint-head', h('b', 'Placing furniture'), h('button.ws-hint-ok', { type: 'button', onclick: () => { store.set(HINT_KEY, '1'); hint.hidden = true; syncStage() } }, 'Got it')),
      row('<circle cx="14" cy="14" r="9" stroke="#D9A441" stroke-width="1.5" stroke-dasharray="2.5 3"/><circle cx="14" cy="14" r="4" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/>', 'Tap a piece', 'Then drag it across the floor'),
      row('<circle cx="10" cy="15" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><circle cx="18" cy="11" r="3.5" fill="rgba(236,232,224,.2)" stroke="#ECE8E0" stroke-width="1.5"/><path d="M6 19l-2.5 2.5M3.5 18.5v3h3M22 7l2.5-2.5M24.5 7.5v-3h-3" stroke="#D9A441" stroke-width="1.5"/>', 'Two fingers', 'Pinch to zoom into the photo, drag to pan'))
  }

  // --- the stage: the part of the window the photo fits into -----------------------------------------------------------
  function syncStage(): void {
    const m = shell.metrics()
    const sheet = m.mode === 'desktop' ? null : shell.getOpenPanel()
    engine.setStageInsets(stageInsets(m.mode, m.chromeLeft, m.safe.top, m.safe.bottom, m.sheetH, !!sheet && sheet.detent !== 'full', adjustCard.hidden ? null : adjustCard.offsetHeight))
  }

  // --- the whole chrome from the current state ----------------------------------------------------------------------------
  function sync(): void {
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
    const selSig = `${String(sel)}|${it?.missing ? '1' : '0'}|${it?.noGlb ? '1' : '0'}|${shell.mode}`
    if (set(selBar, showSel) && (!selBar.childElementCount || selBar.dataset['sig'] !== selSig)) { selBar.dataset['sig'] = selSig; buildSelBar() }
    if (!showSel) { selBar.dataset['sig'] = ''; lift.replaceChildren(); elevInputs.clear(); dropBtns.clear() }
    set(lift, showSel && phone())
    if (showSel) syncElev()
    const wasAdj = !adjustCard.hidden
    if (set(adjustCard, adj && open && !busy())) {
      if (!adjustCard.childElementCount || adjustCard.dataset['mode'] !== shell.mode) { adjustCard.dataset['mode'] = shell.mode; buildAdjust() }
      adjustSync?.()
    } else if (wasAdj) { adjustCard.replaceChildren(); adjustCard.dataset['mode'] = '' }
    toolRow.hidden = !phone() || showSel || (adj && open) || !open
    root.dataset['wsBar'] = bottomBar(phone(), adj, open, showSel)
    root.dataset['wsAdjust'] = adj && open ? '1' : ''
    renderHint()
    if (wasAdj !== !adjustCard.hidden) requestAnimationFrame(syncStage)
  }
  const rebuild = (): void => { buildTools(); selBar.replaceChildren(); lift.replaceChildren(); adjustCard.replaceChildren(); hint.replaceChildren(); emptyCard.replaceChildren(); sync(); syncStage() }

  for (const ev of ['scene', 'dirty', 'selection', 'adjust', 'occlusion', 'grid', 'look', 'layouts'] as const) engine.events.addEventListener(ev, sync)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') sync(); else if (e.detail.uid === engine.getSelected()) syncElev() })
  engine.events.addEventListener('camera', () => { if (!adjustCard.hidden) adjustSync?.(); renderSwitcher() })
  engine.events.addEventListener('ruler', () => { if (!adjustCard.hidden) adjustSync?.() })
  engine.events.addEventListener('view', syncTools)
  engine.events.addEventListener('adjust', (e) => { if (e.detail.on && phone()) { const p = shell.getOpenPanel(); if (p) shell.closePanel() } })
  scenes.events.addEventListener('scenes', () => { renderSwitcher(); if (!loadCard.hidden) renderLoadCard(); renderEmpty() })
  shell.events.addEventListener('mode', rebuild)
  shell.events.addEventListener('page', () => { sync() })
  shell.events.addEventListener('layout', () => { syncStage() })
  shell.events.addEventListener('panel', () => { sync(); syncStage() })

  // --- keys: Del with Undo, ⌘Z, Esc leaves Adjust floor -------------------------------------------------------------------
  shell.addKeyFilter((e) => {
    const t = e.target
    const typing = t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t instanceof HTMLElement && t.isContentEditable))
    const act = workspaceKey({
      key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, typing, selected: !!engine.getSelected(),
      canUndo: !!lastRemoved, adjusting: engine.getAdjustFloor(), rulerActive: engine.getRuler().active,
    })
    if (act === 'remove') { e.preventDefault(); removeSelected(); return true }
    if (act === 'undo' && lastRemoved) { e.preventDefault(); const l = lastRemoved; lastRemoved = null; l.toast.close(); l.undo(); return true }
    if (act === 'leave-adjust') { e.preventDefault(); setAdjust(false); return true }
    return false
  })

  // --- the grip: drag around the item's center to rotate it (15° steps on touch, Shift on desktop) -------------------------
  grip.addEventListener('pointerdown', (e) => {
    const uid = engine.getSelected()
    if (!uid || !engine.beginRotateDrag(uid, e.clientX, e.clientY)) return
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.dataset['touch'] = e.pointerType !== 'mouse' ? '1' : ''
  })
  grip.addEventListener('pointermove', (e) => { if (engine.getDrag()?.mode === 'rotate') engine.dragTo(e.clientX, e.clientY, { snapTo: grip.dataset['touch'] === '1' }) })
  const gripUp = (): void => { if (engine.getDrag()?.mode === 'rotate') engine.endItemDrag() }
  grip.addEventListener('pointerup', gripUp)
  grip.addEventListener('pointercancel', gripUp)
  grip.addEventListener('click', (e) => { if (e.detail === 0) engine.rotateSelected(15) }) // keyboard activation

  // --- the horizon handle: drag it up or down to set the pitch -----------------------------------------------------------
  let hz: { readonly id: number; readonly y0: number; readonly py0: number } | null = null
  horizonHandle.addEventListener('pointerdown', (e) => {
    if (!engine.getAdjustFloor()) return
    e.preventDefault()
    horizonHandle.setPointerCapture(e.pointerId)
    const ph = engine.getPhotoSize()
    hz = { id: e.pointerId, y0: e.clientY, py0: engine.horizonAt(ph.w / 2) ?? ph.h / 2 }
    horizonHandle.classList.add('is-active')
  })
  horizonHandle.addEventListener('pointermove', (e) => {
    if (hz?.id !== e.pointerId) return
    const rect = engine.getPhotoRect()
    const s = rect.w / engine.getPhotoSize().w
    engine.setPitchFromHorizon(horizonDragRow(hz.py0, e.clientY - hz.y0, s, horizonDragGain(engine.getCamera().fov_y_deg, rect.h)))
  })
  const hzUp = (): void => { hz = null; horizonHandle.classList.remove('is-active') }
  horizonHandle.addEventListener('pointerup', hzUp)
  horizonHandle.addEventListener('pointercancel', hzUp)
  horizonHandle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); engine.setCamera({ pitch_deg: engine.getCamera().pitch_deg + (e.key === 'ArrowUp' ? 0.25 : -0.25) }) }
  })
  horizonHandle.tabIndex = 0

  // --- ruler handles: drag a point along the floor ------------------------------------------------------------------------
  let rDrag: { readonly i: number; readonly touch: boolean } | null = null
  handles.forEach((el, i) => {
    el.addEventListener('pointerdown', (e) => {
      if (!engine.getRuler().active) return
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      rDrag = { i, touch: e.pointerType !== 'mouse' }
    })
    el.addEventListener('pointermove', (e) => { if (rDrag?.i === i) engine.setRulerPointAt(i, e.clientX, e.clientY - (rDrag.touch ? 30 : 0)) })
    const up = (): void => { if (rDrag?.i === i) rDrag = null }
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })

  // --- per frame: place the overlay -------------------------------------------------------------------------------------
  const px = (el: HTMLElement, x: number, y: number): void => { el.style.transform = `translate(${String(Math.round(x))}px, ${String(Math.round(y))}px)` }
  const hide = (...els: HTMLElement[]): void => { for (const el of els) if (!el.hidden) el.hidden = true }
  const vw = (): number => window.innerWidth
  const vh = (): number => window.innerHeight
  const line = (el: SVGElement, a: readonly [number, number], b: readonly [number, number]): void => {
    el.setAttribute('x1', a[0].toFixed(1)); el.setAttribute('y1', a[1].toFixed(1)); el.setAttribute('x2', b[0].toFixed(1)); el.setAttribute('y2', b[1].toFixed(1))
  }
  const show2 = (a: SVGElement, b: SVGElement, on: boolean): void => { a.style.display = b.style.display = on ? '' : 'none' }
  let clipKey = ''
  function drawFrame(): void {
    const sel = engine.getSelected()
    const adj = engine.getAdjustFloor()
    const showSel = !!sel && !busy() && !adj
    // The footprint, guide, horizon and ruler lines stay on the photo, never over the letterbox bars or the chrome.
    if (engine.getSceneName()) {
      const key = clipInset(engine.getVisiblePhotoRect(), vw(), vh())
      if (key !== clipKey) { clipKey = key; svg.style.clipPath = key }
    }
    // selection footprint, label, grip
    const f = showSel ? engine.getFootprint(sel) : null
    const s = f ? f.corners.map((c) => engine.worldToScreen(c)) : null
    const it = f ? engine.getItem(sel) : null
    const front = s?.every((p) => p.visible) ? frontCorner(s, Math.hypot) : null
    if (f && s && it && front) {
      fpPoly.setAttribute('points', s.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
      const { fr, dx, dy } = front
      line(fpStem, [fr.x, fr.y], [fr.x + dx * 11, fr.y + dy * 11])
      const liftR = lift.hidden ? null : lift.getBoundingClientRect()
      const liftLeft = liftR?.width ? liftR.left : null
      const g = gripSpot(front, engine.getVisiblePhotoRect(), vw(), vh(), selBar.hidden ? vh() : selBar.getBoundingClientRect().top, liftLeft)
      px(grip, g.x, g.y)
      const where = upText(it.position[1])
      const text = `${it.name}|${dimsText(it.lib.dims_cm)}|${where}|${it.missing ? '1' : '0'}`
      if (label.dataset['text'] !== text) {
        label.dataset['text'] = text
        fill(label, h('b', it.missing ? `${it.name} · missing` : it.name), it.lib.dims_cm ? h('span', dimsText(it.lib.dims_cm)) : null, where ? h('span.ws-label-up', where) : null)
      }
      if (it.position[1] > 0.02) {
        const top = engine.worldToScreen([f.center[0], it.position[1], f.center[2]])
        const foot = engine.worldToScreen([f.center[0], 0, f.center[2]])
        if (top.visible && foot.visible) {
          line(guide, [top.x, top.y], [foot.x, foot.y])
          guideDot.setAttribute('cx', foot.x.toFixed(1))
          guideDot.setAttribute('cy', foot.y.toFixed(1))
          show2(guide, guideDot, true)
        } else show2(guide, guideDot, false)
      } else show2(guide, guideDot, false)
      const pts: Pt[] = s
      const at = labelSpot(pts, g, label.offsetWidth || 140, label.offsetHeight || 40, selBar.hidden ? vh() : selBar.getBoundingClientRect().top, vw(), vh(), liftLeft,
        () => Math.min(...f.box.map((p) => engine.worldToScreen(p).y)))
      px(label, at.x, at.y)
      show2(fpPoly, fpStem, true)
      label.hidden = false
      grip.hidden = false
    } else {
      show2(fpPoly, fpStem, false)
      show2(guide, guideDot, false)
      hide(label, grip)
    }
    drawHorizon(adj && !busy())
    drawRuler(adj && !busy())
  }
  engine.onFrame(drawFrame)
  // The horizon line across the photo, and its handle at the photo's centre column (kept inside the visible area,
  // with an arrow when the horizon itself is above or below it).
  function drawHorizon(show: boolean): void {
    const ph = engine.getPhotoSize()
    const y0 = show ? engine.horizonAt(0) : null
    const y1 = show ? engine.horizonAt(ph.w) : null
    if (!show || y0 === null || y1 === null) { show2(horizonLine, horizonShadow, false); hide(horizonHandle, horizonTag); return }
    const a = engine.photoToClient(0, y0)
    const b = engine.photoToClient(ph.w, y1)
    line(horizonLine, a, b)
    line(horizonShadow, a, b)
    show2(horizonLine, horizonShadow, true)
    const st: Rect = engine.getVisiblePhotoRect()
    const c = engine.photoToClient(ph.w / 2, engine.horizonAt(ph.w / 2) ?? 0) // (null reads as 0, as v1's arithmetic did)
    const spot = handleSpot(c[0], c[1], st)
    px(horizonHandle, spot.x - 22, spot.y - 22)
    horizonHandle.hidden = false
    horizonHandle.dataset['off'] = spot.off
    if (horizonTag.textContent !== spot.text) horizonTag.textContent = spot.text
    px(horizonTag, spot.x + 26, spot.y - 13)
    horizonTag.hidden = false
  }
  function drawRuler(show: boolean): void {
    const r = show ? engine.getRuler() : null
    const sp = r?.active ? r.points.map((p) => engine.worldToScreen(p)) : []
    handles.forEach((el, i) => { const p = sp[i]; if (p?.visible) { px(el, p.x - 22, p.y - 22); el.hidden = false } else el.hidden = true })
    const [p0, p1] = sp
    if (r && sp.length === 2 && p0 && p1 && p0.visible && p1.visible) {
      line(rulerLine, [p0.x, p0.y], [p1.x, p1.y])
      line(rulerShadow, [p0.x, p0.y], [p1.x, p1.y])
      show2(rulerLine, rulerShadow, true)
      const txt = `${String(Math.round((r.meters ?? 0) * 100))} cm`
      if (pill.dataset['text'] !== txt) { pill.dataset['text'] = txt; fill(pill, h('b', txt)) }
      const pw = pill.offsetWidth || 70
      px(pill, (p0.x + p1.x) / 2 - pw / 2, (p0.y + p1.y) / 2 - 38)
      pill.hidden = false
    } else {
      show2(rulerLine, rulerShadow, false)
      pill.hidden = true
    }
  }

  // --- keyboard inset (phone): cards ride above the keyboard ---------------------------------------------------------------
  const vv = window.visualViewport
  function syncKb(): void {
    const kb = keyboardInset(window.innerHeight, vv ? vv.height : null, vv ? vv.offsetTop : 0)
    root.style.setProperty('--kb', `${String(Math.round(kb))}px`)
    root.dataset['kb'] = kb > 80 ? 'up' : ''
  }
  vv?.addEventListener('resize', syncKb)
  vv?.addEventListener('scroll', syncKb)
  syncKb()

  ctx.workspace = { setAdjust }
  buildTools()
  sync()
  syncStage()
}
