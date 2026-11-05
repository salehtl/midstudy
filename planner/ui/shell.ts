// midstudy planner shell: phone vs desktop chrome, panels (desktop side panel / phone bottom sheets), pages (Scenes),
// toasts, confirm dialogs, "…" menus and tooltips. Area modules (workspace, panels, rooms) build on it; see main.js.
//
// createShell({ engine }) → shell
//   mode, isPhone()                 'phone' (≤ 760 px wide or a coarse pointer) | 'desktop'; switches live on resize
//   mounts                          { view, overlays, topbar, rail, modebar, dock, panel, sheet, pages, toasts, layer }
//   events                          'mode' { mode }, 'panel' { id, open, detent }, 'page' { id, open }, 'layout' metrics
//   metrics()                       { mode, width, height, usable, safe: {top,bottom,left,right}, sheetH, chromeBottom, chromeLeft }
// Panels (desktop: rail of section icons + 264 px body; phone: dock → bottom sheet)
//   registerPanel({ id, label, short?, icon, phoneDetent = 'half', order?, mount(body, api), onOpen(info), onClose() }) → api
//     api = { id, body, head, actions, setTitle(text), setCount(text), setStatus(node|text|null), open(opts), close(), isOpen(), detent() }
//     `short` is the dock/rail label ("In scene"); `label` is the panel title ("In the scene").
//   The photo's stage (the part of the window it fits into) is set by the workspace from 'layout' and 'panel' events.
//   openPanel(id, { detent }), closePanel(), togglePanel(id), getOpenPanel() → { id, detent } | null
//   setDetent('peek'|'half'|'full')  phone only
// Pages (phone: full-height sheet; desktop: overlay under the bar, `width` px wide)
//   registerPage({ id, label, width = 880, mount(body, api), onOpen(info), onClose() }) → api (same shape as a panel's)
//   openPage(id), closePage(), getOpenPage() → id | null
// Feedback
//   toast(text, { kind: 'info'|'ok'|'error', icon, action: { label, onClick }, ms, id }) → { el, close(), update(text) }
//     info/ok leave after 4 s (8 s with an action); errors stay until closed. Same id or text replaces the old one.
//   confirm({ title, body, icon, danger, confirm: 'OK', cancel: 'Cancel' }) → Promise<boolean>
//   confirm({ title, body, icon, actions: [{ label, value, kind: 'primary'|'secondary'|'danger'|'quiet', default, cancel }] }) → Promise<value>
//     desktop: dialog (Enter = default action, Esc = cancel); phone: action sheet (cancel is the separate bottom button)
//   menu(anchorEl, [{ label, icon, kbd, danger, disabled, midstudy (a data-midstudy test handle), onSelect } | '-'], { align: 'end'|'start' }) → { close() }
//   Tooltips: any element with data-tip="Measure" (and data-kbd="M") shows the kit tooltip on desktop hover.
// Keys: shell.addKeyFilter(fn) — fn(keydown) → true swallows it before engine input sees it. While a dialog, menu or
// page is open, every key is swallowed (they handle their own).
import { icon, ring, unsavedGlyph } from './icons.js'
import { h, kbd } from './kit.js'
import { Bus } from '../bus.js'
import {
  chromeMetrics, detentPx, dockSplit, dragSheetHeight, isDetent, menuSpot, modeFor, movedAway, phoneToastCloses, settleDetent,
  tapDetent, tipSpot, toastIcon, toastLife, usableHeight,
  type Detent, type Edges, type Mode,
} from './logic/chrome.js'
import type { ToastKind } from '../logic/messages.js'
import type { Engine, RenderMeta } from './seam.js'

interface Safe {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}
interface Metrics {
  readonly mode: Mode
  readonly width: number
  readonly height: number
  readonly usable: number
  readonly safe: Safe
  readonly sheetH: number
  readonly chromeBottom: number
  readonly chromeLeft: number
}
interface ShellEvents {
  mode: { readonly mode: Mode }
  panel: { readonly id: string; readonly open: boolean; readonly detent: Detent | null }
  page: { readonly id: string | undefined; readonly open: boolean }
  layout: Metrics
  'render-request': Record<string, never>
  'open-render': { readonly meta: RenderMeta | undefined }
}
interface Mounts {
  readonly view: HTMLElement
  readonly overlays: HTMLElement
  readonly topbar: HTMLElement
  readonly rail: HTMLElement
  readonly modebar: HTMLElement
  readonly dock: HTMLElement
  readonly panel: HTMLElement
  readonly sheet: HTMLElement
  readonly pages: HTMLElement
  readonly toasts: HTMLElement
  readonly layer: HTMLElement
}

/** A panel's or a page's head and body, as its module fills them. */
interface AreaApi {
  readonly id: string
  readonly body: HTMLDivElement
  readonly head: HTMLDivElement
  readonly actions: HTMLDivElement
  readonly setTitle: (t: string | null | undefined) => void
  readonly setCount: (t: string | number | null | undefined) => void
  readonly setStatus: (n: Node | string | null | undefined) => void
}
interface PanelApi extends AreaApi {
  readonly open: (opts?: { readonly detent?: Detent }) => void
  readonly close: () => void
  readonly isOpen: () => boolean
  readonly detent: () => Detent | null
}
interface PageApi extends AreaApi {
  readonly open: () => void
  readonly close: () => void
  readonly isOpen: () => boolean
}
interface PanelSpec {
  readonly id: string
  readonly label: string
  readonly short?: string
  readonly icon: string
  readonly phoneDetent?: Detent
  readonly order?: number
  readonly mount?: (body: HTMLDivElement, api: PanelApi) => void
  readonly onOpen?: (info: { readonly mode: Mode; readonly detent: Detent | null }) => void
  readonly onClose?: () => void
}
interface PageSpec {
  readonly id: string
  readonly label: string
  readonly width?: number
  readonly mount?: (body: HTMLDivElement, api: PageApi) => void
  readonly onOpen?: (info: { readonly mode: Mode }) => void
  readonly onClose?: () => void
}
interface ToastOptions {
  readonly kind?: ToastKind
  readonly icon?: string
  readonly action?: { readonly label: string; readonly onClick?: () => void } | undefined
  readonly ms?: number
  readonly id?: string
}
export interface ToastHandle {
  readonly el: HTMLDivElement
  readonly close: () => void
  readonly update: (text: string) => void
}
interface ConfirmBase {
  readonly title?: string
  readonly body?: string
  readonly icon?: string
  readonly danger?: boolean
}
export interface ConfirmAction<V> {
  readonly label: string
  readonly value: V
  readonly kind?: string
  readonly default?: boolean
  readonly cancel?: boolean
}
interface ConfirmOptions extends ConfirmBase {
  readonly actions?: undefined
  readonly confirm?: string
  readonly cancel?: string
}
interface ConfirmChoice<V> extends ConfirmBase {
  readonly actions: readonly ConfirmAction<V>[]
}
interface MenuItem {
  readonly label: string
  readonly icon?: string
  readonly kbd?: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly midstudy?: string
  readonly separator?: boolean
  readonly onSelect?: () => void
}
export interface Shell {
  readonly mode: Mode
  readonly isPhone: () => boolean
  readonly mounts: Mounts
  readonly events: Bus<ShellEvents>
  readonly metrics: () => Metrics
  readonly registerPanel: (spec: PanelSpec) => PanelApi
  readonly openPanel: (id: string, opts?: { readonly detent?: Detent | undefined }) => void
  readonly closePanel: () => void
  readonly togglePanel: (id: string) => void
  readonly getOpenPanel: () => { readonly id: string; readonly detent: Detent | null } | null
  readonly setDetent: (d: Detent, opts?: { readonly silent?: boolean }) => void
  readonly registerPage: (spec: PageSpec) => PageApi
  readonly openPage: (id: string) => void
  readonly closePage: () => void
  readonly getOpenPage: () => string | null
  readonly toast: (text: string, opts?: ToastOptions) => ToastHandle
  readonly confirm: {
    (opts: ConfirmOptions): Promise<boolean>
    <V>(opts: ConfirmChoice<V>): Promise<V | null>
  }
  readonly menu: (anchor: Element | null, items: readonly (MenuItem | '-')[], opts?: { readonly align?: 'end' | 'start'; readonly above?: boolean }) => { readonly close: () => void }
  readonly addKeyFilter: (fn: (e: KeyboardEvent) => boolean) => () => void
  readonly glyphs: { readonly ring: typeof ring; readonly unsavedGlyph: typeof unsavedGlyph }
}

interface Panel {
  readonly spec: PanelSpec
  readonly order: number
  readonly phoneDetent: Detent
  readonly api: PanelApi
}
interface Page {
  readonly spec: PageSpec
  readonly width: number
  readonly api: PageApi
}
interface Toast {
  readonly key: string
  readonly el: HTMLDivElement
  readonly kind: ToastKind
  timer: ReturnType<typeof setTimeout> | undefined
  close: (instant?: boolean) => void
}
interface Modal {
  readonly els: readonly Element[]
  readonly cancel: () => void
  enter: (() => void) | null
}
interface SheetDrag {
  readonly id: number
  readonly y0: number
  readonly h0: number
  t: number
  y: number
  v: number
  moved: boolean
}

function mountOf(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`createShell: no #${id} in the page`)
  return el
}
// The element an event happened on (or its text node's parent).
function elementOf(t: EventTarget | null): Element | null {
  return t instanceof Element ? t : t instanceof Node ? t.parentElement : null
}

export function createShell({ engine }: { readonly engine: Engine | null }): Shell {
  const root = document.documentElement
  const events = new Bus<ShellEvents>()
  const mounts: Mounts = {
    view: mountOf('view'), overlays: mountOf('overlays'), topbar: mountOf('topbar'), rail: mountOf('rail'), modebar: mountOf('modebar'), dock: mountOf('dock'),
    panel: mountOf('panel'), sheet: mountOf('sheet'), pages: mountOf('pages'), toasts: mountOf('toasts'), layer: mountOf('layer'),
  }
  const store = {
    get: (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k: string, v: string): void => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  }

  // --- mode + metrics -------------------------------------------------------------------------------------
  const coarse = matchMedia('(pointer: coarse)')
  let mode: Mode | null = null
  const probe = h('div', { style: { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', top: '0', left: '0',
    paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' } })
  document.body.append(probe)
  function safe(): Safe {
    const s = getComputedStyle(probe)
    return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0, right: parseFloat(s.paddingRight) || 0 }
  }
  const m = { width: 0, height: 0, usable: 0, safe: { top: 0, bottom: 0, left: 0, right: 0 }, sheetH: 0, chromeBottom: 0, chromeLeft: 0 }
  function measure(): void {
    m.width = window.innerWidth
    m.height = window.innerHeight // the layout viewport: the page's own bottom is above Safari's bar
    m.safe = safe()
    m.usable = usableHeight(m.height, m.safe.top, m.safe.bottom)
    root.style.setProperty('--vh', `${String(m.height)}px`)
  }
  const px = (d: Detent): number => detentPx(d, m.usable)
  const currentMode = (): Mode => mode ?? modeFor(window.innerWidth, coarse.matches)

  function applyMode(): boolean {
    const next = modeFor(window.innerWidth, coarse.matches)
    if (next === mode) return false
    const prev = mode
    mode = next
    root.dataset['mode'] = mode
    if (prev) rehost(prev)
    events.emit('mode', { mode })
    return true
  }

  // --- panels -------------------------------------------------------------------------------------------------
  const panels = new Map<string, Panel>()
  let openId: string | null = null  // phone: the sheet's panel; desktop: the side panel's section (shown unless collapsed)
  let detent: Detent | null = null  // phone sheet detent while open
  let collapsed = store.get('midstudy.panel.collapsed') === '1'
  const sorted = (): Panel[] => [...panels.values()].sort((a, b) => a.order - b.order)
  const firstPanel = (): Panel | undefined => sorted()[0]

  function makeHead(spec: { readonly id: string; readonly label: string }): AreaApi {
    const title = h('h2.panel-title', spec.label)
    const count = h('span.panel-count')
    const status = h('span.panel-status')
    const actions = h('div.panel-actions')
    const head = h('div.panel-head', h('div.panel-title-wrap', title, count, status), actions)
    const body = h('div.panel-body', { dataset: { panel: spec.id } })
    return {
      id: spec.id, body, head, actions,
      setTitle: (t) => { title.textContent = t ?? '' },
      setCount: (t) => { count.textContent = t === null || t === undefined ? '' : String(t) },
      setStatus: (n) => { status.replaceChildren(...(n === null || n === undefined || n === '' ? [] : [n])) },
    }
  }

  function registerPanel(spec: PanelSpec): PanelApi {
    if (!spec.id || panels.has(spec.id)) throw new Error(`registerPanel: missing or duplicate id "${spec.id}"`)
    const api: PanelApi = {
      ...makeHead(spec),
      open: (o) => { openPanel(spec.id, o) },
      close: () => { if (openId === spec.id) closePanel() },
      isOpen: () => isPanelOpen(spec.id),
      detent: () => (isPanelOpen(spec.id) && mode === 'phone' ? detent : null),
    }
    const p: Panel = { spec, order: spec.order ?? panels.size * 10, phoneDetent: spec.phoneDetent ?? 'half', api }
    panels.set(spec.id, p)
    try { spec.mount?.(api.body, api) } catch (e) { engine?.reportError(`Could not set up the ${spec.label || spec.id} panel`, e) }
    buildDock()
    buildRail()
    const first = firstPanel()
    if (mode === 'desktop' && !openId && !collapsed && first) openPanel(first.spec.id)
    return api
  }

  const isPanelOpen = (id: string): boolean => openId === id && (mode === 'phone' ? !!detent : !collapsed)
  function getOpenPanel(): { readonly id: string; readonly detent: Detent | null } | null {
    return openId && isPanelOpen(openId) ? { id: openId, detent: mode === 'phone' ? detent : null } : null
  }

  function openPanel(id: string, { detent: d }: { readonly detent?: Detent | undefined } = {}): void {
    const p = panels.get(id)
    if (!p) return
    const was = getOpenPanel()
    if (was && was.id !== id) panels.get(was.id)?.spec.onClose?.()
    openId = id
    if (mode === 'phone') {
      showInSheet(p)
      setDetent(isDetent(d) ? d : was?.id === id && detent ? detent : p.phoneDetent, { silent: true })
    } else {
      collapsed = false
      store.set('midstudy.panel.collapsed', '0')
      showInSide(p)
    }
    if (was?.id !== id) p.spec.onOpen?.({ mode: currentMode(), detent: mode === 'phone' ? detent : null })
    syncChrome()
    events.emit('panel', { id, open: true, detent: mode === 'phone' ? detent : null })
  }

  function closePanel(): void {
    const was = getOpenPanel()
    if (!was) return
    const p = panels.get(was.id)
    if (mode === 'phone') { detent = null; sheet.classList.remove('is-open'); sheet.style.height = '0px' } else { collapsed = true; store.set('midstudy.panel.collapsed', '1') }
    p?.spec.onClose?.()
    syncChrome()
    events.emit('panel', { id: was.id, open: false, detent: null })
  }
  const togglePanel = (id: string): void => { if (isPanelOpen(id)) closePanel(); else openPanel(id) }

  // Desktop side panel: rail + body
  const sideRail = h('nav.side-rail', { 'aria-label': 'Panels' })
  const sideHead = h('header.side-head')
  const sideContent = h('div.side-content.scroll')
  mounts.panel.classList.add('side')
  mounts.panel.append(sideRail, h('div.side-body', sideHead, sideContent))
  function buildRail(): void {
    const tabs = sorted().map((p) => h('button.side-tab', {
      type: 'button', dataset: { id: p.spec.id, tip: p.spec.label }, 'aria-current': String(openId === p.spec.id && !collapsed),
      onclick: () => { if (openId === p.spec.id && !collapsed) closePanel(); else openPanel(p.spec.id) },
    }, icon(p.spec.icon, { size: 20 }), h('span', (p.spec.short ?? '') || p.spec.label)))
    const collapse = h('button.side-collapse', { type: 'button', 'aria-label': collapsed ? 'Show panel' : 'Collapse panel', dataset: { tip: collapsed ? 'Show panel' : 'Collapse panel' },
      onclick: () => {
        if (!collapsed) { closePanel(); return }
        const target = openId ?? firstPanel()?.spec.id
        if (target !== undefined) openPanel(target)
      } }, icon('panel', { size: 20 }))
    sideRail.replaceChildren(...tabs, h('div.side-spacer'), collapse)
  }
  function showInSide(p: Panel): void {
    sideHead.replaceChildren(p.api.head)
    sideContent.replaceChildren(p.api.body)
  }

  // Phone dock: up to five panels, more under More
  function buildDock(): void {
    const { main, rest } = dockSplit(sorted())
    const item = (label: string, ic: string, current: boolean, onclick: (e: MouseEvent) => void): HTMLButtonElement =>
      h('button.dock-item', { type: 'button', 'aria-current': String(current), onclick }, icon(ic, { size: 20 }), h('span', label))
    const items = main.map((p) => item((p.spec.short ?? '') || p.spec.label, p.spec.icon, openId === p.spec.id && !!detent, () => { togglePanel(p.spec.id) }))
    if (rest.length) {
      const more = item('More', 'more', rest.some((p) => openId === p.spec.id && !!detent), (e) => {
        const only = rest.length === 1 ? rest[0] : undefined
        if (only) { togglePanel(only.spec.id); return }
        menu(e.currentTarget instanceof Element ? e.currentTarget : null, rest.map((p) => ({ label: p.spec.label, icon: p.spec.icon, onSelect: () => { openPanel(p.spec.id) } })), { align: 'end', above: true })
      })
      items.push(more)
    }
    mounts.dock.replaceChildren(...items)
  }

  // Phone bottom sheet
  const sheet = mounts.sheet
  sheet.classList.add('sheet')
  sheet.setAttribute('role', 'dialog')
  const grab = h('div.sheet-grab', { 'aria-hidden': 'true' })
  const sheetHead = h('header.sheet-head')
  const sheetClose = h('button.sheet-close', { type: 'button', 'aria-label': 'Close', onclick: () => { closePanel() } }, h('span', icon('close', { size: 16, stroke: 2 })))
  const sheetBody = h('div.sheet-body')
  sheet.append(grab, sheetHead, sheetBody)
  const scrim = h('div', { id: 'sheet-scrim', onclick: () => { setDetent('half') } })
  sheet.before(scrim)
  function showInSheet(p: Panel): void {
    sheetHead.replaceChildren(p.api.head, sheetClose)
    sheetBody.replaceChildren(p.api.body)
    sheet.setAttribute('aria-label', p.spec.label)
    sheet.classList.add('is-open')
  }
  function setDetent(d: Detent, { silent = false }: { readonly silent?: boolean } = {}): void {
    if (mode !== 'phone' || !openId || !isDetent(d)) return
    detent = d
    sheet.style.height = `${String(px(d) + m.safe.bottom)}px`
    syncChrome()
    if (!silent) events.emit('panel', { id: openId, open: true, detent })
  }
  // Drag the grabber or the header: follow the finger, then settle on the nearest detent (a fling counts), or close.
  let drag: SheetDrag | null = null
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || elementOf(e.target)?.closest('button, input, select, textarea, a, [data-nodrag]')) return
    drag = { id: e.pointerId, y0: e.clientY, h0: sheet.getBoundingClientRect().height - m.safe.bottom, t: performance.now(), y: e.clientY, v: 0, moved: false }
    if (e.currentTarget instanceof Element) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent): void => {
    if (drag?.id !== e.pointerId) return
    const now = performance.now()
    drag.v = (e.clientY - drag.y) / Math.max(1, now - drag.t)
    drag.t = now
    drag.y = e.clientY
    if (!drag.moved && Math.abs(e.clientY - drag.y0) < 6) return
    drag.moved = true
    sheet.classList.add('is-dragging')
    const hgt = dragSheetHeight(drag.h0, e.clientY - drag.y0, m.usable)
    sheet.style.height = `${String(hgt + m.safe.bottom)}px`
    root.style.setProperty('--sheet-h', `${String(hgt + m.safe.bottom)}px`)
  }
  const onUp = (e: PointerEvent): void => {
    if (drag?.id !== e.pointerId) return
    const d = drag
    drag = null
    sheet.classList.remove('is-dragging')
    if (!d.moved) { setDetent(tapDetent(detent)); return } // tap: grow
    const best = settleDetent(d.h0 - (d.y - d.y0), d.v, m.usable)
    if (best === null) { closePanel(); return }
    setDetent(best)
  }
  for (const el of [grab, sheetHead]) {
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  function rehost(prev: Mode): void {
    const p = openId ? panels.get(openId) : undefined
    if (prev === 'phone' && mode === 'desktop') {
      const wasOpen = !!detent
      detent = null
      sheet.classList.remove('is-open')
      sheet.style.height = '0px'
      const first = firstPanel()
      if (p && (wasOpen || !collapsed)) { collapsed = false; showInSide(p) } else if (!p && !collapsed && first) { openId = first.spec.id; showInSide(first) }
    } else if (prev === 'desktop' && mode === 'phone') {
      detent = null // the sheet starts closed on the phone; the dock opens it
      sheet.classList.remove('is-open')
    }
    buildDock()
    buildRail()
    const page = pageOpen ? pages.get(pageOpen) : undefined
    if (page) mountPage(page)
  }

  // Chrome sizes → CSS vars, the engine's view inset, and the attributes the CSS keys off.
  function syncChrome(): void {
    root.dataset['sheet'] = mode === 'phone' && detent ? detent : ''
    root.dataset['panel'] = mode === 'desktop' ? (collapsed ? 'collapsed' : 'open') : ''
    const c = chromeMetrics(currentMode(), mode === 'phone' ? detent : null, m.usable, m.safe.bottom, panels.size > 0, collapsed)
    m.sheetH = c.sheetH
    m.chromeBottom = c.chromeBottom
    m.chromeLeft = c.chromeLeft
    root.style.setProperty('--sheet-h', `${String(m.sheetH)}px`)
    root.style.setProperty('--chrome-bottom', `${String(m.chromeBottom)}px`)
    root.style.setProperty('--chrome-left', `${String(m.chromeLeft)}px`)
    root.style.setProperty('--chrome-top', mode === 'desktop' ? '52px' : `${String(m.safe.top)}px`)
    buildDock()
    buildRail()
    events.emit('layout', metrics())
  }
  const metrics = (): Metrics => ({ mode: currentMode(), ...m, safe: { ...m.safe } })

  // --- pages (Scenes) -------------------------------------------------------------------------------------
  const pages = new Map<string, Page>()
  let pageOpen: string | null = null
  let pageEls: HTMLElement[] = []
  function registerPage(spec: PageSpec): PageApi {
    if (!spec.id || pages.has(spec.id)) throw new Error(`registerPage: missing or duplicate id "${spec.id}"`)
    const api: PageApi = {
      ...makeHead(spec),
      open: () => { openPage(spec.id) },
      close: () => { if (pageOpen === spec.id) closePage() },
      isOpen: () => pageOpen === spec.id,
    }
    const p: Page = { spec, width: (spec.width ?? 0) || 880, api }
    pages.set(spec.id, p)
    try { spec.mount?.(api.body, api) } catch (e) { engine?.reportError(`Could not set up ${spec.label || spec.id}`, e) }
    return api
  }
  function mountPage(p: Page): void {
    for (const el of pageEls) el.remove()
    const close = h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Close', onclick: () => { closePage() } }, icon('close', { size: mode === 'phone' ? 18 : 16 }))
    const head = h('header.page-head', p.api.head, mode === 'desktop' ? kbd('Esc') : null, close)
    const body = h('div.page-body')
    body.append(p.api.body)
    // (v1 sets --page-w through Object.assign on the style, which sets no custom property: the CSS default applies.)
    const el = h('section.page', { role: 'dialog', 'aria-label': p.spec.label || p.spec.id, style: { '--page-w': `${String(p.width)}px` } },
      mode === 'phone' ? h('div.sheet-grab', { 'aria-hidden': 'true' }) : null, head, body)
    pageEls = mode === 'phone' ? [h('div.page-scrim', { onclick: () => { closePage() } }), el] : [el]
    mounts.pages.append(...pageEls)
    if (mode === 'phone') {
      el.classList.add('is-entering')
      requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.remove('is-entering') }))
      // swipe the grabber or header down to close
      let y0: number | null = null
      const grabEl = el.querySelector('.sheet-grab')
      for (const t of [grabEl, head]) {
        if (!(t instanceof HTMLElement)) continue
        t.addEventListener('pointerdown', (e) => {
          if (elementOf(e.target)?.closest('button, input, a')) return
          y0 = e.clientY
          t.setPointerCapture(e.pointerId)
        })
        t.addEventListener('pointermove', (e) => { if (y0 !== null) el.style.transform = `translateY(${String(Math.max(0, e.clientY - y0))}px)` })
        t.addEventListener('pointerup', (e) => {
          if (y0 === null) return
          const dy = e.clientY - y0
          y0 = null
          el.style.transform = ''
          if (dy > 120) closePage()
        })
        t.addEventListener('pointercancel', () => { y0 = null; el.style.transform = '' })
      }
    }
  }
  function openPage(id: string): void {
    const p = pages.get(id)
    if (!p) return
    if (pageOpen && pageOpen !== id) closePage()
    if (pageOpen === id) return
    pageOpen = id
    mountPage(p)
    p.spec.onOpen?.({ mode: currentMode() })
    events.emit('page', { id, open: true })
  }
  function closePage(): void {
    if (!pageOpen) return
    const p = pages.get(pageOpen)
    pageOpen = null
    for (const el of pageEls) el.remove()
    pageEls = []
    p?.spec.onClose?.()
    events.emit('page', { id: p?.spec.id, open: false })
  }
  // Desktop: a click into the room closes the overlay.
  mounts.view.addEventListener('pointerdown', () => { if (pageOpen && mode === 'desktop') closePage() })

  // --- toasts --------------------------------------------------------------------------------------------
  const toasts: Toast[] = []
  function toast(text: string, { kind = 'info', icon: ic, action, ms, id }: ToastOptions = {}): ToastHandle {
    const key = (id ?? '') || `${kind}:${text}`
    const old = toasts.find((t) => t.key === key)
    if (old) old.close(true)
    const textEl = h('span.toast-text', text)
    const el = h(`div.toast.toast-${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, icon(toastIcon(kind, ic), { size: 20 }), textEl)
    const t: Toast = {
      key, el, kind, timer: undefined,
      close: (instant = false) => {
        clearTimeout(t.timer)
        const i = toasts.indexOf(t)
        if (i >= 0) toasts.splice(i, 1)
        if (instant) { el.remove(); return }
        el.classList.add('is-leaving')
        setTimeout(() => { el.remove() }, 200)
      },
    }
    const update = (next: string): void => { textEl.textContent = next }
    if (action) el.append(h('button.toast-action', { type: 'button', onclick: () => { t.close(); action.onClick?.() } }, action.label))
    el.append(h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { t.close() } }, icon('close', { size: 16 })))
    const life = toastLife(kind, !!action, ms)
    if (life > 0) t.timer = setTimeout(() => { t.close() }, life)
    toasts.push(t)
    mounts.toasts.append(el)
    // The phone's photo is short: one message at a time over it (errors stay until closed, one at most besides).
    if (mode === 'phone') for (const o of toasts.slice()) if (o !== t && phoneToastCloses(o.kind, kind)) o.close(true)
    while (toasts.length > 3) toasts[0]?.close(true)
    return { el, close: () => { t.close() }, update }
  }

  // --- layer: dialogs, action sheets, menus, tooltips ------------------------------------------------------
  const modals: Modal[] = [] // innermost last
  function pushModal(els: readonly Element[], cancel: () => void): { readonly modal: Modal; readonly done: () => void } {
    const modal: Modal = { els, cancel, enter: null }
    modals.push(modal)
    mounts.layer.append(...els)
    return { modal, done: () => { const i = modals.indexOf(modal); if (i >= 0) modals.splice(i, 1); for (const e of els) e.remove() } }
  }

  function ask<V>(base: ConfirmBase, actions: readonly ConfirmAction<V>[]): Promise<V | null> {
    const { title = '', body = '', icon: ic, danger = false } = base
    const cancelAction = actions.find((a) => a.cancel) ?? null
    const cancelValue = cancelAction ? cancelAction.value : null
    return new Promise((resolve) => {
      let done: (() => void) | null = null
      const finish = (v: V | null): void => { done?.(); resolve(v) }
      const mkBtn = (a: ConfirmAction<V>): HTMLButtonElement => h(`button.btn.btn-${(a.kind ?? '') || 'secondary'}`, { type: 'button', onclick: () => { finish(a.value) } }, a.label)
      if (mode === 'desktop') {
        const btns = actions.map(mkBtn)
        const dlg = h('div.dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div.dialog-main',
            ic ? h(`div.dialog-icon${danger ? '.is-danger' : ''}`, icon(ic, { size: 20 })) : null,
            h('div.dialog-text', h('h2.dialog-title', title), body ? h('p.dialog-body', body) : null)),
          h('div.dialog-actions', btns))
        const sc = h('div.scrim', { onclick: () => { finish(cancelValue) } })
        const pushed = pushModal([sc, dlg], () => { finish(cancelValue) })
        done = pushed.done
        const def = actions.findIndex((a) => a.default)
        ;(btns[def] ?? btns.at(-1))?.focus()
        const defAction = actions[def]
        pushed.modal.enter = defAction ? () => { finish(defAction.value) } : null
      } else {
        const main = actions.filter((a) => a !== cancelAction).map((a) => { const b = mkBtn(a); b.classList.add('btn-block'); return b })
        const sheetEl = h('div.actionsheet', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div.actionsheet-card',
            h('div.actionsheet-text', h('h2.actionsheet-title', title), body ? h('p.actionsheet-body', body) : null),
            main.length ? h('div.actionsheet-buttons', main) : null),
          cancelAction ? h('button.actionsheet-cancel', { type: 'button', onclick: () => { finish(cancelValue) } }, cancelAction.label) : null)
        const sc = h('div.scrim', { onclick: () => { finish(cancelValue) } })
        done = pushModal([sc, sheetEl], () => { finish(cancelValue) }).done
      }
    })
  }
  function confirm(opts: ConfirmOptions): Promise<boolean>
  function confirm<V>(opts: ConfirmChoice<V>): Promise<V | null>
  function confirm<V>(opts: ConfirmOptions | ConfirmChoice<V>): Promise<boolean | V | null> {
    if (opts.actions !== undefined) return ask(opts, opts.actions)
    return ask(opts, [
      { label: (opts.cancel ?? '') || 'Cancel', value: false, kind: 'secondary', cancel: true },
      { label: (opts.confirm ?? '') || 'OK', value: true, kind: opts.danger ? 'danger' : 'primary', default: true },
    ])
  }

  function menu(anchor: Element | null, items: readonly (MenuItem | '-')[], { align = 'end', above = false }: { readonly align?: 'end' | 'start'; readonly above?: boolean } = {}): { readonly close: () => void } {
    let done: (() => void) | null = null
    const close = (): void => { done?.(); anchor?.setAttribute('aria-expanded', 'false') }
    const buttons: HTMLButtonElement[] = []
    const el = h('div.menu', { role: 'menu' }, items.map((it) => {
      if (it === '-' || it.separator) return h('div.menu-sep', { role: 'separator' })
      const b = h(`button.menu-item${it.danger ? '.is-danger' : ''}`, { type: 'button', role: 'menuitem', disabled: !!it.disabled, dataset: it.midstudy ? { midstudy: it.midstudy } : null,
        onclick: () => { close(); it.onSelect?.() } }, it.icon ? icon(it.icon, { size: mode === 'phone' ? 20 : 15 }) : null, h('span.label', it.label), it.kbd ? kbd(it.kbd) : null)
      buttons.push(b)
      return b
    }))
    const catcher = h('div', { style: { position: 'fixed', inset: '0' }, onpointerdown: (e) => { e.preventDefault(); close() } })
    done = pushModal([catcher, el], close).done
    anchor?.setAttribute('aria-expanded', 'true')
    // place it under (or above) the anchor, inside the window
    const r: Edges = anchor?.getBoundingClientRect() ?? { left: m.width / 2, right: m.width / 2, top: m.height / 2, bottom: m.height / 2, width: 0, height: 0 }
    const mr = el.getBoundingClientRect()
    const at = menuSpot(r, mr.width, mr.height, m.width, m.height, align === 'end', above)
    Object.assign(el.style, { left: `${String(at.x)}px`, top: `${String(at.y)}px` })
    el.addEventListener('keydown', (e) => {
      const live = buttons.filter((b) => !b.disabled)
      const focused = document.activeElement
      const i = focused instanceof HTMLButtonElement ? live.indexOf(focused) : -1
      if (e.key === 'ArrowDown') { e.preventDefault(); live[(i + 1) % live.length]?.focus() }
      if (e.key === 'ArrowUp') { e.preventDefault(); live[(i - 1 + live.length) % live.length]?.focus() }
    })
    if (mode === 'desktop') buttons.find((b) => !b.disabled)?.focus()
    return { close }
  }

  // Tooltips (desktop hover): data-tip + optional data-kbd
  let tipEl: HTMLElement | null = null
  let tipTimer: ReturnType<typeof setTimeout> | undefined
  let tipFor: { readonly el: Element; readonly x: number; readonly y: number } | null = null // the element the tip is about and where it was when the tip was placed
  const hideTip = (): void => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; tipFor = null }
  // A press hides the tip and none shows until the button is up again; a tip whose element moved (the grip follows the
  // piece) goes too, so it never stays behind at an old spot.
  let dragging = false
  document.addEventListener('pointerover', (e) => {
    if (mode !== 'desktop' || e.pointerType !== 'mouse') return
    const t = elementOf(e.target)?.closest('[data-tip]')
    hideTip()
    if (!(t instanceof HTMLElement) || e.buttons) return // not during a drag (the rotate grip moves under the pointer)
    tipTimer = setTimeout(() => {
      if (!t.isConnected || !t.matches(':hover') || dragging) return
      const tip = h('div.tooltip', { role: 'tooltip' }, h('span', t.dataset['tip']), t.dataset['kbd'] ? kbd(t.dataset['kbd']) : null)
      tipEl = tip
      mounts.layer.append(tip)
      const r = t.getBoundingClientRect()
      const tr = tip.getBoundingClientRect()
      tipFor = { el: t, x: r.left, y: r.top }
      // side rail tabs: to the right instead
      const at = tipSpot(r, tr.width, tr.height, m.width, m.height, !!t.closest('.side-rail'))
      Object.assign(tip.style, { left: `${String(at.x)}px`, top: `${String(at.y)}px` })
    }, 450)
  })
  document.addEventListener('pointerdown', () => { dragging = true; hideTip() }, true)
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => { dragging = false }, true)
  document.addEventListener('pointermove', (e) => {
    if (!tipEl || !tipFor) return
    const r = tipFor.el.getBoundingClientRect()
    if (e.buttons || !tipFor.el.isConnected || movedAway(r.left, r.top, tipFor.x, tipFor.y)) hideTip()
  }, true)

  // --- keys: Esc closes the innermost layer; modals swallow keys before the engine's input sees them -------------
  const keyFilters: ((e: KeyboardEvent) => boolean)[] = []
  const addKeyFilter = (fn: (e: KeyboardEvent) => boolean): (() => void) => {
    keyFilters.push(fn)
    return () => { keyFilters.splice(keyFilters.indexOf(fn), 1) }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const top = modals.at(-1)
    if (top) { e.preventDefault(); top.cancel(); return }
    if (pageOpen && !elementOf(e.target)?.closest('input, textarea')) { e.preventDefault(); closePage() }
  }, true)
  window.addEventListener('keydown', (e) => {
    const enter = modals.at(-1)?.enter
    if (e.key === 'Enter' && enter && !elementOf(e.target)?.closest('button, input, textarea')) { e.preventDefault(); enter() }
  }, true)
  engine?.input?.setKeyFilter((e) => modals.length > 0 || pageOpen !== null || keyFilters.some((f) => f(e)))

  // --- touch: no page zoom (iOS ignores user-scalable=no) ----------------------------------------------
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => { e.preventDefault() }, { passive: false })
  document.addEventListener('dblclick', (e) => { if (mode === 'phone') e.preventDefault() }, { passive: false })

  // --- live resize --------------------------------------------------------------------------------------
  const onResize = (): void => {
    measure()
    applyMode()
    if (mode === 'phone' && detent && !drag) sheet.style.height = `${String(px(detent) + m.safe.bottom)}px`
    syncChrome()
  }
  window.addEventListener('resize', onResize)
  window.visualViewport?.addEventListener('resize', onResize)
  coarse.addEventListener('change', onResize)
  measure()
  applyMode()
  syncChrome()

  return {
    get mode() { return currentMode() },
    isPhone: () => mode === 'phone',
    mounts,
    events,
    metrics,
    registerPanel,
    openPanel,
    closePanel,
    togglePanel,
    getOpenPanel,
    setDetent,
    registerPage,
    openPage,
    closePage,
    getOpenPage: () => pageOpen,
    toast,
    confirm,
    menu,
    addKeyFilter,
    glyphs: { ring, unsavedGlyph },
  }
}

